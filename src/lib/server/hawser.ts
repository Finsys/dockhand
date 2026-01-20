/**
 * Hawser Edge Connection Manager
 *
 * Manages WebSocket connections from Hawser agents running in Edge mode.
 * Handles request/response correlation, heartbeat tracking, and metrics collection.
 */

import { db, hawserTokens, environments, eq } from './db/drizzle.js';
import { logContainerEvent, saveHostMetric, type ContainerEventAction } from './db.js';
import { containerEventEmitter } from './event-collector.js';
import { sendEnvironmentNotification } from './notifications.js';
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
	lastHeartbeat: Date;
	pendingRequests: Map<string, PendingRequest>;
	pendingStreamRequests: Map<string, PendingStreamRequest>;
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
			if (now - conn.lastHeartbeat.getTime() > timeout) {
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

				conn.ws.close(1001, 'Connection timeout');
				edgeConnections.delete(envId);
				updateEnvironmentStatus(envId, null);
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

// Register global handler for patch-build.ts to use
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

		// Save to database using the existing function
		await saveHostMetric(
			cpuPercent,
			memoryPercent,
			metrics.memoryUsed,
			metrics.memoryTotal,
			environmentId
		);
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
	// Get all active tokens
	const tokens = await db.select().from(hawserTokens).where(eq(hawserTokens.isActive, true));

	// Check each token (tokens are hashed)
	for (const t of tokens) {
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
			// Invalid hash, continue checking
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
			pending.reject(new Error('Connection replaced by new agent'));
		}
		for (const [requestId, pending] of existing.pendingStreamRequests) {
			console.log(`[Hawser] Ending stream request ${requestId} due to connection replacement`);
			pending.onEnd?.('Connection replaced by new agent');
		}
		existing.pendingRequests.clear();
		existing.pendingStreamRequests.clear();

		existing.ws.close(1000, 'Replaced by new connection');
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
		lastHeartbeat: new Date(),
		pendingRequests: new Map(),
		pendingStreamRequests: new Map()
	};

	edgeConnections.set(environmentId, connection);

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
	timeout = 30000
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
			body: body, // Body is already an object, will be serialized by JSON.stringify(message)
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
		connection.lastHeartbeat = new Date();
	}
}

/**
 * Handle connection close
 */
export function handleDisconnect(environmentId: number): void {
	const connection = edgeConnections.get(environmentId);
	if (connection) {
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
	body?: unknown; // JSON-serializable object, will be serialized when message is stringified
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
