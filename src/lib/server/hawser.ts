/**
 * Hawser Edge Connection Manager
 *
 * Manages WebSocket connections from Hawser agents running in Edge mode.
 * Handles request/response correlation, heartbeat tracking, and metrics collection.
 */

import { db, hawserTokens, environments, eq, and } from './db/drizzle.js';
import { logContainerEvent, type ContainerEventAction } from './db.js';
import { containerEventEmitter } from './event-collector.js';
import { sendEnvironmentNotification } from './notifications.js';
import { pushMetric } from './metrics-store.js';
import { secureGetRandomValues, secureRandomUUID } from './crypto-fallback.js';
import { hashPassword, verifyPassword } from './auth.js';

// Protocol constants
export const HAWSER_PROTOCOL_VERSION = '1.0';

// Message types (matching Hawser agent protocol)
export const MessageType = {
	HELLO: 'hello',
	WELCOME: 'welcome',
	REQUEST: 'request',
	RESPONSE: 'response',
	STREAM: 'stream',
	STREAM_END: 'stream_end',
	METRICS: 'metrics',
	PING: 'ping',
	PONG: 'pong',
	ERROR: 'error'
} as const;

// Active edge connections mapped by environment ID
export interface EdgeConnection {
	ws: WebSocket;
	environmentId: number;
	agentId: string;
	agentName: string;
	agentVersion: string;
	dockerVersion: string;
	hostname: string;
	capabilities: string[];
	connectedAt: Date;
	lastHeartbeat: number;
	pendingRequests: Map<string, PendingRequest>;
	pendingStreamRequests: Map<string, PendingStreamRequest>;
	pingInterval?: ReturnType<typeof setInterval>;
	lastMetrics?: {
		uptime?: number;
		cpuUsage?: number;
		memoryTotal?: number;
		memoryUsed?: number;
	};
}

interface PendingRequest {
	resolve: (response: EdgeResponse) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
}

interface PendingStreamRequest {
	onData: (data: string, stream?: 'stdout' | 'stderr') => void;
	onEnd: (reason?: string) => void;
	onError: (error: string) => void;
}

export interface EdgeResponse {
	statusCode: number;
	headers: Record<string, string>;
	body: string | Uint8Array;
	isBinary?: boolean;
}

// Global map of active connections (stored in globalThis for dev mode sharing with vite.config.ts)
declare global {
	var __hawserEdgeConnections: Map<number, EdgeConnection> | undefined;
	var __hawserSendMessage: ((envId: number, message: string) => boolean) | undefined;
	var __hawserHandleContainerEvent: ((envId: number, event: ContainerEventMessage['event']) => Promise<void>) | undefined;
	var __hawserHandleMetrics: ((envId: number, metrics: MetricsMessage['metrics']) => Promise<void>) | undefined;
	var __hawserHandleMessage: ((ws: any, msg: any, connId: string, remoteIp?: string) => Promise<void>) | undefined;
	var __hawserHandleDisconnect: ((ws: any, connId: string) => void) | undefined;
	var __terminalHandleExecMessage: ((msg: any) => void) | undefined;
}
export const edgeConnections: Map<number, EdgeConnection> =
	globalThis.__hawserEdgeConnections ?? (globalThis.__hawserEdgeConnections = new Map());

// Cleanup interval for stale connections (check every 30 seconds)
let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * Initialize the edge connection manager
 */
export function initializeEdgeManager(): void {
	if (cleanupInterval) return;

	cleanupInterval = setInterval(() => {
		const now = Date.now();
		const timeout = 90 * 1000; // 90 seconds (3 missed heartbeats)

		for (const [envId, conn] of edgeConnections) {
			if (now - conn.lastHeartbeat > timeout) {
				const pendingCount = conn.pendingRequests.size;
				const streamCount = conn.pendingStreamRequests.size;
				console.log(
					`[Hawser] Connection timeout for environment ${envId}. ` +
					`Rejecting ${pendingCount} pending requests and ${streamCount} stream requests.`
				);

				// Reject all pending requests before closing
				for (const [requestId, pending] of conn.pendingRequests) {
					console.log(`[Hawser] Rejecting pending request ${requestId} due to connection timeout`);
					clearTimeout(pending.timeout);
					pending.reject(new Error('Connection timeout'));
				}
				for (const [requestId, pending] of conn.pendingStreamRequests) {
					console.log(`[Hawser] Ending stream request ${requestId} due to connection timeout`);
					pending.onEnd?.('Connection timeout');
				}
				conn.pendingRequests.clear();
				conn.pendingStreamRequests.clear();

				if (conn.pingInterval) {
					clearInterval(conn.pingInterval);
					conn.pingInterval = undefined;
				}

				conn.ws.close(1001, 'Connection timeout');
				edgeConnections.delete(envId);
				updateEnvironmentStatus(envId, null);
			}
		}

		// Maintain reconnection tracker: reset for stable connections, prune stale entries
		for (const [envId, tracker] of reconnectTracker) {
			const conn = edgeConnections.get(envId);
			if (conn && now - conn.lastHeartbeat < STABLE_THRESHOLD_MS) {
				// Connection is stable — reset tracker so next reconnect is unthrottled
				reconnectTracker.delete(envId);
			} else if (!conn && tracker.timestamps.length > 0) {
				const lastAttempt = tracker.timestamps[tracker.timestamps.length - 1];
				if (now - lastAttempt > STALE_TRACKER_MS) {
					// No connection and no recent attempts — clean up
					reconnectTracker.delete(envId);
				}
			}
		}
	}, 30000);
}

/**
 * Stop the edge connection manager
 */
export function stopEdgeManager(): void {
	if (cleanupInterval) {
		clearInterval(cleanupInterval);
		cleanupInterval = null;
	}

	// Close all connections
	for (const [, conn] of edgeConnections) {
		conn.ws.close(1001, 'Server shutdown');
	}
	edgeConnections.clear();
	reconnectTracker.clear();
}

/**
 * Handle container event from Edge agent
 * Saves to database, emits to SSE clients, and sends notifications
 */
export async function handleEdgeContainerEvent(
	environmentId: number,
	event: ContainerEventMessage['event']
): Promise<void> {
	try {
		// Log the event
		console.log(`[Hawser] Container event from env ${environmentId}: ${event.action} ${event.containerName || event.containerId}`);

		// Save to database
		const savedEvent = await logContainerEvent({
			environmentId,
			containerId: event.containerId,
			containerName: event.containerName || null,
			image: event.image || null,
			action: event.action as ContainerEventAction,
			actorAttributes: event.actorAttributes || null,
			timestamp: event.timestamp
		});

		// Broadcast to SSE clients
		containerEventEmitter.emit('event', savedEvent);

		// Prepare notification
		const actionLabel = event.action.charAt(0).toUpperCase() + event.action.slice(1);
		const containerLabel = event.containerName || event.containerId.substring(0, 12);
		const notificationType =
			event.action === 'die' || event.action === 'kill' || event.action === 'oom'
				? 'error'
				: event.action === 'stop'
					? 'warning'
					: event.action === 'start'
						? 'success'
						: 'info';

		// Send notification
		await sendEnvironmentNotification(environmentId, event.action as ContainerEventAction, {
			title: `Container ${actionLabel}`,
			message: `Container "${containerLabel}" ${event.action}${event.image ? ` (${event.image})` : ''}`,
			type: notificationType as 'success' | 'error' | 'warning' | 'info'
		}, event.image);
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error('[Hawser] Error handling container event:', errorMsg);
	}
}

// Register global handler for server.js to use
globalThis.__hawserHandleContainerEvent = handleEdgeContainerEvent;

/**
 * Handle metrics from Edge agent
 * Saves to database for dashboard graphs and stores latest metrics in connection
 */
export async function handleEdgeMetrics(
	environmentId: number,
	metrics: MetricsMessage['metrics']
): Promise<void> {
	try {
		// Store latest metrics in the edge connection for quick access (e.g., uptime)
		const connection = edgeConnections.get(environmentId);
		if (connection) {
			connection.lastMetrics = {
				uptime: metrics.uptime,
				cpuUsage: metrics.cpuUsage,
				memoryTotal: metrics.memoryTotal,
				memoryUsed: metrics.memoryUsed
			};
		}

		// Normalize CPU by core count (agent sends raw percentage across all cores)
		const cpuPercent = metrics.cpuCores > 0 ? metrics.cpuUsage / metrics.cpuCores : metrics.cpuUsage;
		const memoryPercent = metrics.memoryTotal > 0
			? (metrics.memoryUsed / metrics.memoryTotal) * 100
			: 0;

		// Push to in-memory ring buffer
		pushMetric(environmentId, cpuPercent, memoryPercent, metrics.memoryUsed, metrics.memoryTotal);
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error('[Hawser] Error saving metrics:', errorMsg);
	}
}

// Register global handler for metrics
globalThis.__hawserHandleMetrics = handleEdgeMetrics;

/**
 * Validate a Hawser token
 */
export async function validateHawserToken(
	token: string
): Promise<{ valid: boolean; environmentId?: number; tokenId?: number }> {
	// Fast path: lookup by token prefix (first 8 chars) instead of iterating all tokens.
	// This reduces O(N) Argon2id verifications to O(1) DB lookup + 1 verify.
	const prefix = token.substring(0, 8);
	const candidates = await db
		.select()
		.from(hawserTokens)
		.where(and(eq(hawserTokens.tokenPrefix, prefix), eq(hawserTokens.isActive, true)));

	for (const t of candidates) {
		try {
			const isValid = await verifyPassword(token, t.token);
			if (isValid) {
				// Update last used timestamp
				await db
					.update(hawserTokens)
					.set({ lastUsed: new Date().toISOString() })
					.where(eq(hawserTokens.id, t.id));

				return {
					valid: true,
					environmentId: t.environmentId ?? undefined,
					tokenId: t.id
				};
			}
		} catch {
			// Invalid hash format, skip
		}
	}

	return { valid: false };
}

/**
 * Generate a new Hawser token for an environment
 * @param rawToken - Optional pre-generated token (base64url string). If not provided, generates a new one.
 */
export async function generateHawserToken(
	name: string,
	environmentId: number,
	expiresAt?: string,
	rawToken?: string
): Promise<{ token: string; tokenId: number }> {
	// Close any existing edge connection for this environment
	// This forces the agent to reconnect with the new token
	const existingConnection = edgeConnections.get(environmentId);
	if (existingConnection) {
		console.log(`[Hawser] Closing existing connection for env ${environmentId} due to new token generation`);
		existingConnection.ws.close(1000, 'Token regenerated');
		edgeConnections.delete(environmentId);
	}

	// Revoke all existing active tokens for this environment so the old agent
	// can no longer reconnect and fight with the new one over the connection slot
	await db
		.update(hawserTokens)
		.set({ isActive: false })
		.where(and(eq(hawserTokens.environmentId, environmentId), eq(hawserTokens.isActive, true)));

	// Use provided token or generate a new one
	let token: string;
	if (rawToken) {
		// Use the pre-generated token directly (already in base64url format)
		token = rawToken;
	} else {
		// Generate a secure random token (32 bytes = 256 bits)
		const tokenBytes = new Uint8Array(32);
		secureGetRandomValues(tokenBytes);
		token = Buffer.from(tokenBytes).toString('base64url');
	}

	// Hash the token for storage (using Argon2id)
	const hashedToken = await hashPassword(token);

	// Get prefix for identification
	const tokenPrefix = token.substring(0, 8);

	// Store in database
	const result = await db
		.insert(hawserTokens)
		.values({
			token: hashedToken,
			tokenPrefix,
			name,
			environmentId,
			isActive: true,
			expiresAt
		})
		.returning({ id: hawserTokens.id });

	return {
		token, // Return unhashed token (only shown once)
		tokenId: result[0].id
	};
}

/**
 * Revoke a Hawser token
 */
export async function revokeHawserToken(tokenId: number): Promise<void> {
	await db.update(hawserTokens).set({ isActive: false }).where(eq(hawserTokens.id, tokenId));
}

/**
 * Close an Edge connection and clean up pending requests.
 * Called when an environment is deleted.
 */
export function closeEdgeConnection(environmentId: number): void {
	const connection = edgeConnections.get(environmentId);
	if (!connection) {
		console.log(`[Hawser] No Edge connection to close for environment ${environmentId}`);
		return;
	}

	const pendingCount = connection.pendingRequests.size;
	const streamCount = connection.pendingStreamRequests.size;
	console.log(
		`[Hawser] Closing Edge connection for deleted environment ${environmentId}. ` +
		`Rejecting ${pendingCount} pending requests and ${streamCount} stream requests.`
	);

	// Clear ping interval
	if (connection.pingInterval) {
		clearInterval(connection.pingInterval);
		connection.pingInterval = undefined;
	}

	// Reject all pending requests
	for (const [requestId, pending] of connection.pendingRequests) {
		console.log(`[Hawser] Rejecting pending request ${requestId} due to environment deletion`);
		clearTimeout(pending.timeout);
		pending.reject(new Error('Environment deleted'));
	}
	for (const [requestId, pending] of connection.pendingStreamRequests) {
		console.log(`[Hawser] Ending stream request ${requestId} due to environment deletion`);
		pending.onEnd?.('Environment deleted');
	}
	connection.pendingRequests.clear();
	connection.pendingStreamRequests.clear();

	// Close the WebSocket
	try {
		connection.ws.close(1000, 'Environment deleted');
	} catch (e) {
		const errorMsg = e instanceof Error ? e.message : String(e);
		console.error(`[Hawser] Error closing WebSocket for environment ${environmentId}:`, errorMsg);
	}

	edgeConnections.delete(environmentId);
	console.log(`[Hawser] Edge connection closed for environment ${environmentId}`);
}

/**
 * Handle a new edge connection from a Hawser agent
 */
export function handleEdgeConnection(
	ws: WebSocket,
	environmentId: number,
	hello: HelloMessage
): EdgeConnection {
	// Check if there's already a connection for this environment
	const existing = edgeConnections.get(environmentId);
	if (existing) {
		const pendingCount = existing.pendingRequests.size;
		const streamCount = existing.pendingStreamRequests.size;
		console.log(
			`[Hawser] Replacing existing connection for environment ${environmentId}. ` +
			`Rejecting ${pendingCount} pending requests and ${streamCount} stream requests.`
		);

		// Reject all pending requests before closing
		for (const [requestId, pending] of existing.pendingRequests) {
			console.log(`[Hawser] Rejecting pending request ${requestId} due to connection replacement`);
			clearTimeout(pending.timeout);
			pending.reject(new Error('Connection replaced by new agent'));
		}
		for (const [requestId, pending] of existing.pendingStreamRequests) {
			console.log(`[Hawser] Ending stream request ${requestId} due to connection replacement`);
			pending.onEnd?.('Connection replaced by new agent');
		}
		existing.pendingRequests.clear();
		existing.pendingStreamRequests.clear();

		// Clear ping interval before closing
		if (existing.pingInterval) {
			clearInterval(existing.pingInterval);
			existing.pingInterval = undefined;
		}

		// Immediately destroy TCP socket — no graceful close needed for replaced connections
		if (typeof existing.ws.terminate === 'function') {
			existing.ws.terminate();
		} else {
			existing.ws.close(1000, 'Replaced by new connection');
		}
	}

	const connection: EdgeConnection = {
		ws,
		environmentId,
		agentId: hello.agentId,
		agentName: hello.agentName,
		agentVersion: hello.version,
		dockerVersion: hello.dockerVersion,
		hostname: hello.hostname,
		capabilities: hello.capabilities,
		connectedAt: new Date(),
		lastHeartbeat: Date.now(),
		pendingRequests: new Map(),
		pendingStreamRequests: new Map()
	};

	edgeConnections.set(environmentId, connection);

	// Start server-side ping interval to keep connection alive.
	// 5s is conservative against reverse proxies with aggressive idle timeouts.
	connection.pingInterval = setInterval(() => {
		try {
			connection.ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
		} catch {
			clearInterval(connection.pingInterval!);
			connection.pingInterval = undefined;
		}
	}, 5000);

	// Update environment record
	updateEnvironmentStatus(environmentId, connection);

	return connection;
}

/**
 * Update environment status in database
 */
async function updateEnvironmentStatus(
	environmentId: number,
	connection: EdgeConnection | null
): Promise<void> {
	if (connection) {
		await db
			.update(environments)
			.set({
				hawserLastSeen: new Date().toISOString(),
				hawserAgentId: connection.agentId,
				hawserAgentName: connection.agentName,
				hawserVersion: connection.agentVersion,
				hawserCapabilities: JSON.stringify(connection.capabilities),
				updatedAt: new Date().toISOString()
			})
			.where(eq(environments.id, environmentId));
	} else {
		await db
			.update(environments)
			.set({
				hawserLastSeen: new Date().toISOString(),
				updatedAt: new Date().toISOString()
			})
			.where(eq(environments.id, environmentId));
	}
}

/**
 * Send a request to a Hawser agent and wait for response
 */
export async function sendEdgeRequest(
	environmentId: number,
	method: string,
	path: string,
	body?: unknown,
	headers?: Record<string, string>,
	streaming = false,
	timeout = 30000,
	isBinary = false,
	signal?: AbortSignal
): Promise<EdgeResponse> {
	const connection = edgeConnections.get(environmentId);
	if (!connection) {
		throw new Error('Edge agent not connected');
	}

	const requestId = secureRandomUUID();

	return new Promise((resolve, reject) => {
		const timeoutHandle = setTimeout(() => {
			connection.pendingRequests.delete(requestId);
			if (streaming) {
				connection.pendingStreamRequests.delete(requestId);
			}
			reject(new Error('Request timeout'));
		}, timeout);

		// Honor AbortSignal from caller (e.g., AbortSignal.timeout(5000) for dockerPing)
		if (signal) {
			if (signal.aborted) {
				clearTimeout(timeoutHandle);
				reject(new Error('Request aborted'));
				return;
			}
			signal.addEventListener(
				'abort',
				() => {
					connection.pendingRequests.delete(requestId);
					if (streaming) {
						connection.pendingStreamRequests.delete(requestId);
					}
					clearTimeout(timeoutHandle);
					reject(new Error('Request aborted'));
				},
				{ once: true }
			);
		}

		// For streaming requests, the Go agent sends 'stream' messages instead of a single 'response'.
		// We need to register a stream handler that collects all data and resolves when complete.
		if (streaming) {
			// Initialize pendingStreamRequests if not present (dev mode HMR safety)
			if (!connection.pendingStreamRequests) {
				connection.pendingStreamRequests = new Map();
			}

			const chunks: Buffer[] = [];

			connection.pendingStreamRequests.set(requestId, {
				onData: (data: string, stream?: 'stdout' | 'stderr') => {
					// Data is base64 encoded from Go agent
					try {
						const decoded = Buffer.from(data, 'base64');
						chunks.push(decoded);
					} catch {
						// If not base64, use as-is
						chunks.push(Buffer.from(data));
					}
				},
				onEnd: (reason?: string) => {
					clearTimeout(timeoutHandle);
					connection.pendingRequests.delete(requestId);
					connection.pendingStreamRequests.delete(requestId);

					// Combine all chunks and return as response
					const combined = Buffer.concat(chunks);
					resolve({
						statusCode: 200,
						headers: {},
						body: combined,
						isBinary: true
					});
				},
				onError: (error: string) => {
					clearTimeout(timeoutHandle);
					connection.pendingRequests.delete(requestId);
					connection.pendingStreamRequests.delete(requestId);
					reject(new Error(error));
				}
			});
		}

		// Also register in pendingRequests in case the agent sends a 'response' instead of 'stream'
		// (e.g., for error responses or non-streaming paths)
		connection.pendingRequests.set(requestId, {
			resolve: (response: EdgeResponse) => {
				clearTimeout(timeoutHandle);
				if (streaming) {
					connection.pendingStreamRequests.delete(requestId);
				}
				resolve(response);
			},
			reject: (error: Error) => {
				clearTimeout(timeoutHandle);
				if (streaming) {
					connection.pendingStreamRequests.delete(requestId);
				}
				reject(error);
			},
			timeout: timeoutHandle
		});

		const message: RequestMessage = {
			type: MessageType.REQUEST,
			requestId,
			method,
			path,
			headers: headers || {},
			body: body,
			isBinary, // true when body is base64-encoded binary (tar uploads)
			streaming
		};

		const messageStr = JSON.stringify(message);

		// In dev mode, use the global send function from vite.config.ts
		// In production, use the WebSocket directly
		if (globalThis.__hawserSendMessage) {
			const sent = globalThis.__hawserSendMessage(environmentId, messageStr);
			if (!sent) {
				connection.pendingRequests.delete(requestId);
				if (streaming) {
					connection.pendingStreamRequests.delete(requestId);
				}
				clearTimeout(timeoutHandle);
				reject(new Error('Failed to send message'));
			}
		} else {
			try {
				connection.ws.send(messageStr);
			} catch (sendError) {
				const errorMsg = sendError instanceof Error ? sendError.message : String(sendError);
				console.error(`[Hawser Edge] Error sending message:`, errorMsg);
				connection.pendingRequests.delete(requestId);
				if (streaming) {
					connection.pendingStreamRequests.delete(requestId);
				}
				clearTimeout(timeoutHandle);
				reject(sendError as Error);
			}
		}
	});
}

/**
 * Send a streaming request to a Hawser agent
 * Returns a cancel function to stop the stream
 */
export function sendEdgeStreamRequest(
	environmentId: number,
	method: string,
	path: string,
	callbacks: {
		onData: (data: string, stream?: 'stdout' | 'stderr') => void;
		onEnd: (reason?: string) => void;
		onError: (error: string) => void;
	},
	body?: unknown,
	headers?: Record<string, string>
): { requestId: string; cancel: () => void } {
	const connection = edgeConnections.get(environmentId);
	if (!connection) {
		callbacks.onError('Edge agent not connected');
		return { requestId: '', cancel: () => {} };
	}

	const requestId = secureRandomUUID();

	// Initialize pendingStreamRequests if not present (can happen in dev mode due to HMR)
	if (!connection.pendingStreamRequests) {
		connection.pendingStreamRequests = new Map();
	}

	connection.pendingStreamRequests.set(requestId, {
		onData: callbacks.onData,
		onEnd: callbacks.onEnd,
		onError: callbacks.onError
	});

	const message: RequestMessage = {
		type: MessageType.REQUEST,
		requestId,
		method,
		path,
		headers: headers || {},
		body: body, // Body is already an object, will be serialized by JSON.stringify(message)
		streaming: true
	};

	const messageStr = JSON.stringify(message);

	// In dev mode, use the global send function from vite.config.ts
	// In production, use the WebSocket directly
	if (globalThis.__hawserSendMessage) {
		const sent = globalThis.__hawserSendMessage(environmentId, messageStr);
		if (!sent) {
			connection.pendingStreamRequests.delete(requestId);
			callbacks.onError('Failed to send message');
			return { requestId: '', cancel: () => {} };
		}
	} else {
		try {
			connection.ws.send(messageStr);
		} catch (sendError) {
			const errorMsg = sendError instanceof Error ? sendError.message : String(sendError);
			console.error(`[Hawser Edge] Error sending streaming message:`, errorMsg);
			connection.pendingStreamRequests.delete(requestId);
			callbacks.onError(errorMsg);
			return { requestId: '', cancel: () => {} };
		}
	}

	return {
		requestId,
		cancel: () => {
			connection.pendingStreamRequests.delete(requestId);
			// Send stream_end message to agent to stop the stream
			const cancelMessage: StreamEndMessage = {
				type: 'stream_end',
				requestId,
				reason: 'cancelled'
			};
			try {
				connection.ws.send(JSON.stringify(cancelMessage));
			} catch {
				// Connection may already be closed, ignore
			}
		}
	};
}

/**
 * Handle incoming stream data from Hawser agent
 */
export function handleEdgeStreamData(environmentId: number, message: StreamMessage): void {
	const connection = edgeConnections.get(environmentId);
	if (!connection) {
		console.warn(`[Hawser] Stream data for unknown environment ${environmentId}, requestId=${message.requestId}`);
		return;
	}

	const pending = connection.pendingStreamRequests.get(message.requestId);
	if (!pending) {
		console.warn(`[Hawser] Stream data for unknown request ${message.requestId} on env ${environmentId}`);
		return;
	}

	pending.onData(message.data, message.stream);
}

/**
 * Handle stream end from Hawser agent
 */
export function handleEdgeStreamEnd(environmentId: number, message: StreamEndMessage): void {
	const connection = edgeConnections.get(environmentId);
	if (!connection) {
		console.warn(`[Hawser] Stream end for unknown environment ${environmentId}, requestId=${message.requestId}`);
		return;
	}

	const pending = connection.pendingStreamRequests.get(message.requestId);
	if (!pending) {
		console.warn(`[Hawser] Stream end for unknown request ${message.requestId} on env ${environmentId}`);
		return;
	}

	connection.pendingStreamRequests.delete(message.requestId);
	pending.onEnd(message.reason);
}

/**
 * Handle incoming response from Hawser agent
 */
export function handleEdgeResponse(environmentId: number, response: ResponseMessage): void {
	const connection = edgeConnections.get(environmentId);
	if (!connection) {
		console.warn(`[Hawser] Response for unknown environment ${environmentId}, requestId=${response.requestId}`);
		return;
	}

	const pending = connection.pendingRequests.get(response.requestId);
	if (!pending) {
		console.warn(`[Hawser] Response for unknown request ${response.requestId} on env ${environmentId}`);
		return;
	}

	clearTimeout(pending.timeout);
	connection.pendingRequests.delete(response.requestId);

	pending.resolve({
		statusCode: response.statusCode,
		headers: response.headers || {},
		body: response.body || '',
		isBinary: response.isBinary || false
	});
}

/**
 * Handle heartbeat from agent
 */
export function handleHeartbeat(environmentId: number): void {
	const connection = edgeConnections.get(environmentId);
	if (connection) {
		connection.lastHeartbeat = Date.now();
	}
}

/**
 * Handle connection close
 */
export function handleDisconnect(environmentId: number): void {
	const connection = edgeConnections.get(environmentId);
	if (connection) {
		// Clear ping interval
		if (connection.pingInterval) {
			clearInterval(connection.pingInterval);
			connection.pingInterval = undefined;
		}

		// Reject all pending requests
		for (const [, pending] of connection.pendingRequests) {
			clearTimeout(pending.timeout);
			pending.reject(new Error('Connection closed'));
		}

		// End all pending stream requests
		for (const [, pending] of connection.pendingStreamRequests) {
			pending.onEnd('Connection closed');
		}

		edgeConnections.delete(environmentId);
		updateEnvironmentStatus(environmentId, null);
	}
}

/**
 * Check if an environment has an active edge connection
 */
export function isEdgeConnected(environmentId: number): boolean {
	return edgeConnections.has(environmentId);
}

/**
 * Get connection info for an environment
 */
export function getEdgeConnectionInfo(environmentId: number): EdgeConnection | undefined {
	return edgeConnections.get(environmentId);
}

/**
 * Get all active connections
 */
export function getAllEdgeConnections(): Map<number, EdgeConnection> {
	return edgeConnections;
}

// Message type definitions
export interface HelloMessage {
	type: 'hello';
	version: string;
	agentId: string;
	agentName: string;
	token: string;
	dockerVersion: string;
	hostname: string;
	capabilities: string[];
}

export interface WelcomeMessage {
	type: 'welcome';
	environmentId: number;
	message?: string;
}

export interface RequestMessage {
	type: 'request';
	requestId: string;
	method: string;
	path: string;
	headers?: Record<string, string>;
	body?: unknown; // JSON-serializable object, or base64 string when isBinary=true
	isBinary?: boolean; // true when body is base64-encoded binary data (tar uploads)
	streaming?: boolean;
}

export interface ResponseMessage {
	type: 'response';
	requestId: string;
	statusCode: number;
	headers?: Record<string, string>;
	body?: string;
	isBinary?: boolean;
}

export interface StreamMessage {
	type: 'stream';
	requestId: string;
	data: string;
	stream?: 'stdout' | 'stderr';
}

export interface StreamEndMessage {
	type: 'stream_end';
	requestId: string;
	reason?: string;
}

export interface MetricsMessage {
	type: 'metrics';
	timestamp: number;
	metrics: {
		cpuUsage: number;
		cpuCores: number;
		memoryTotal: number;
		memoryUsed: number;
		memoryFree: number;
		diskTotal: number;
		diskUsed: number;
		diskFree: number;
		networkRxBytes: number;
		networkTxBytes: number;
		uptime: number;
	};
}

export interface ErrorMessage {
	type: 'error';
	requestId?: string;
	error: string;
	code?: string;
}

// Exec message types for bidirectional terminal
export interface ExecStartMessage {
	type: 'exec_start';
	execId: string;
	containerId: string;
	cmd: string;
	user: string;
	cols: number;
	rows: number;
}

export interface ExecReadyMessage {
	type: 'exec_ready';
	execId: string;
}

export interface ExecInputMessage {
	type: 'exec_input';
	execId: string;
	data: string; // Base64-encoded
}

export interface ExecOutputMessage {
	type: 'exec_output';
	execId: string;
	data: string; // Base64-encoded
}

export interface ExecResizeMessage {
	type: 'exec_resize';
	execId: string;
	cols: number;
	rows: number;
}

export interface ExecEndMessage {
	type: 'exec_end';
	execId: string;
	reason?: string;
}

export interface ContainerEventMessage {
	type: 'container_event';
	event: {
		containerId: string;
		containerName?: string;
		image?: string;
		action: string;
		actorAttributes?: Record<string, string>;
		timestamp: string;
	};
}

export type HawserMessage =
	| HelloMessage
	| WelcomeMessage
	| RequestMessage
	| ResponseMessage
	| StreamMessage
	| StreamEndMessage
	| MetricsMessage
	| ErrorMessage
	| ExecStartMessage
	| ExecReadyMessage
	| ExecInputMessage
	| ExecOutputMessage
	| ExecResizeMessage
	| ExecEndMessage
	| ContainerEventMessage
	| { type: 'ping'; timestamp: number }
	| { type: 'pong'; timestamp: number };

// ─── Production WebSocket message handler (used by server.js) ───

// Maps WebSocket instances to environment IDs for message routing
const wsToEnvId = new Map<any, number>();

// Auth fail cache to prevent brute-force token validation.
// 5 min cooldown — hawser agents use exponential backoff (30-60s),
// so a short cooldown lets every retry through.
const hawserAuthFailCache = new Map<string, number>();
const HAWSER_AUTH_FAIL_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// Periodic cleanup of expired auth fail entries
setInterval(() => {
	const now = Date.now();
	for (const [key, timestamp] of hawserAuthFailCache) {
		if (now - timestamp > HAWSER_AUTH_FAIL_COOLDOWN_MS) {
			hawserAuthFailCache.delete(key);
		}
	}
}, HAWSER_AUTH_FAIL_COOLDOWN_MS);

// ─── Reconnection storm throttle ───
// Tracks per-environment reconnection frequency to detect storms
// (e.g., agent can auth but Docker socket is broken → 30s timeout → reconnect loop)
interface ReconnectTrackerEntry {
	timestamps: number[];
	cooldownUntil: number;   // 0 = no cooldown active
	cooldownLevel: number;   // index into COOLDOWN_LEVELS
}
const reconnectTracker = new Map<number, ReconnectTrackerEntry>();
const RECONNECT_WINDOW_MS = 2 * 60 * 1000;         // 2-minute sliding window
const RECONNECT_BURST = 10;                          // allow 10 reconnections per window
const COOLDOWN_LEVELS_SECS = [30, 60, 120, 300];    // escalating cooldown in seconds
const STABLE_THRESHOLD_MS = 5 * 60 * 1000;          // stable connection resets tracker
const STALE_TRACKER_MS = 10 * 60 * 1000;            // clean up stale tracker entries

/**
 * Record a reconnection for an environment and check if throttling is needed.
 * Returns { allowed: true } or { allowed: false, retryAfter: seconds }.
 */
function recordReconnection(envId: number): { allowed: true } | { allowed: false; retryAfter: number } {
	const now = Date.now();
	let entry = reconnectTracker.get(envId);

	if (!entry) {
		entry = { timestamps: [now], cooldownUntil: 0, cooldownLevel: 0 };
		reconnectTracker.set(envId, entry);
		return { allowed: true };
	}

	// Check if currently in cooldown
	if (now < entry.cooldownUntil) {
		const retryAfter = Math.ceil((entry.cooldownUntil - now) / 1000);
		return { allowed: false, retryAfter };
	}

	// Prune timestamps outside the sliding window
	entry.timestamps = entry.timestamps.filter(ts => now - ts < RECONNECT_WINDOW_MS);
	entry.timestamps.push(now);

	// Check if burst limit exceeded
	if (entry.timestamps.length > RECONNECT_BURST) {
		const level = Math.min(entry.cooldownLevel, COOLDOWN_LEVELS_SECS.length - 1);
		const cooldownSecs = COOLDOWN_LEVELS_SECS[level];
		entry.cooldownUntil = now + cooldownSecs * 1000;
		entry.cooldownLevel = Math.min(entry.cooldownLevel + 1, COOLDOWN_LEVELS_SECS.length - 1);

		console.warn(
			`[Hawser WS] Reconnection storm detected for env ${envId}: ` +
			`${entry.timestamps.length} connections in ${RECONNECT_WINDOW_MS / 1000}s. ` +
			`Cooldown ${cooldownSecs}s (level ${level})`
		);

		return { allowed: false, retryAfter: cooldownSecs };
	}

	return { allowed: true };
}

/**
 * Handle a WebSocket message from a Hawser Edge agent.
 * Full protocol handler: hello/welcome auth, ping/pong,
 * response/stream routing, metrics, container events, exec sessions.
 *
 * Registered as globalThis.__hawserHandleMessage for server.js to call.
 */
async function handleHawserWsMessage(ws: any, msg: any, connId: string, remoteIp?: string): Promise<void> {
	if (msg.type === 'hello') {
		const rateLimitKey = remoteIp || connId;

		// Rate limit auth failures by remote IP (not connId which is unique per connection)
		const lastFail = hawserAuthFailCache.get(rateLimitKey);
		if (lastFail && Date.now() - lastFail < HAWSER_AUTH_FAIL_COOLDOWN_MS) {
			console.log(`[Hawser WS] Rate limited ${connId} (IP: ${rateLimitKey}) — ${Math.round((Date.now() - lastFail) / 1000)}s since last fail`);
			ws.send(JSON.stringify({ type: 'error', message: 'Too many failed attempts' }));
			ws.close(1008, 'Rate limited');
			return;
		}

		if (!msg.token) {
			ws.send(JSON.stringify({ type: 'error', message: 'No token provided' }));
			ws.close(1008, 'Missing token');
			return;
		}

		try {
			const result = await validateHawserToken(msg.token);
			if (!result.valid || !result.environmentId) {
				console.log(`[Hawser WS] Authentication failed for connection ${connId} (IP: ${rateLimitKey})`);
				hawserAuthFailCache.set(rateLimitKey, Date.now());
				ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
				ws.close(1008, 'Invalid token');
				return;
			}

			// Throttle reconnection storms (successful auth but broken Docker = rapid reconnect loop)
			const throttle = recordReconnection(result.environmentId);
			if (!throttle.allowed) {
				console.log(`[Hawser WS] Throttling reconnection for env ${result.environmentId}: retry after ${throttle.retryAfter}s`);
				ws.send(JSON.stringify({
					type: 'error',
					message: `Reconnection throttled. Retry after ${throttle.retryAfter}s.`,
					retryAfter: throttle.retryAfter
				}));
				ws.close(1008, 'Reconnection throttled');
				return;
			}

			// Authenticated — register the connection
			const connection = handleEdgeConnection(ws, result.environmentId, msg);
			wsToEnvId.set(ws, result.environmentId);

			// Send welcome
			ws.send(JSON.stringify({
				type: 'welcome',
				serverId: 'dockhand',
				version: HAWSER_PROTOCOL_VERSION
			}));

			console.log(`[Hawser WS] Agent authenticated: env=${result.environmentId} agent=${msg.agentName || msg.agentId}`);
		} catch (error: any) {
			console.error('[Hawser WS] Auth error:', error.message);
			ws.send(JSON.stringify({ type: 'error', message: 'Authentication failed' }));
			ws.close(1011, 'Auth error');
		}
		return;
	}

	// All other messages require an authenticated connection
	const envId = wsToEnvId.get(ws);
	if (!envId) {
		ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
		return;
	}

	const connection = edgeConnections.get(envId);
	if (!connection) return;

	// Update heartbeat
	connection.lastHeartbeat = Date.now();

	switch (msg.type) {
		case 'ping':
			ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
			break;

		case 'pong':
			break;

		case 'response': {
			const pending = connection.pendingRequests.get(msg.requestId);
			if (pending) {
				clearTimeout(pending.timeout);
				connection.pendingRequests.delete(msg.requestId);
				pending.resolve({
					statusCode: msg.statusCode,
					headers: msg.headers || {},
					body: msg.body,
					isBinary: msg.isBinary
				});
			}
			break;
		}

		case 'stream': {
			const streamPending = connection.pendingStreamRequests.get(msg.requestId);
			if (streamPending) {
				streamPending.onData?.(msg.data);
			}
			break;
		}

		case 'stream_end': {
			const streamReq = connection.pendingStreamRequests.get(msg.requestId);
			if (streamReq) {
				connection.pendingStreamRequests.delete(msg.requestId);
				streamReq.onEnd?.(msg.reason);
			}
			break;
		}

		case 'metrics':
			if (globalThis.__hawserHandleMetrics) {
				await globalThis.__hawserHandleMetrics(envId, msg.metrics);
			}
			break;

		case 'container_event':
			if (globalThis.__hawserHandleContainerEvent) {
				await globalThis.__hawserHandleContainerEvent(envId, msg.event);
			}
			break;

		case 'exec_ready':
		case 'exec_output':
		case 'exec_end':
			// Forward exec messages to server.js/vite.config.ts via global callback
			if (globalThis.__terminalHandleExecMessage) {
				globalThis.__terminalHandleExecMessage(msg);
			}
			break;

		case 'error':
			console.error(`[Hawser WS] Agent error (env ${envId}): ${msg.message}`);
			// Forward exec-related errors (identified by requestId) to terminal handler
			if (msg.requestId && globalThis.__terminalHandleExecMessage) {
				globalThis.__terminalHandleExecMessage(msg);
			}
			break;
	}
}

/**
 * Handle WebSocket disconnect for a Hawser Edge agent.
 * Receives the actual ws object to correctly identify which connection closed.
 */
function handleHawserWsDisconnect(disconnectedWs: any, connId: string): void {
	const envId = wsToEnvId.get(disconnectedWs);
	if (!envId) {
		// This ws was never authenticated (e.g., auth failed), nothing to clean up
		return;
	}

	const connection = edgeConnections.get(envId);
	if (connection && connection.ws === disconnectedWs) {
		console.log(`[Hawser WS] Agent disconnected: env=${envId}`);

		for (const [, pending] of connection.pendingRequests) {
			clearTimeout(pending.timeout);
			pending.reject(new Error('Agent disconnected'));
		}
		for (const [, pending] of connection.pendingStreamRequests) {
			pending.onEnd?.('Agent disconnected');
		}
		connection.pendingRequests.clear();
		connection.pendingStreamRequests.clear();

		edgeConnections.delete(envId);
		updateEnvironmentStatus(envId, null);
	}

	wsToEnvId.delete(disconnectedWs);
}

// Register global handlers for server.js to call
globalThis.__hawserHandleMessage = handleHawserWsMessage;
globalThis.__hawserHandleDisconnect = handleHawserWsDisconnect;
