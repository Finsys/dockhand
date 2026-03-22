import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws';
import * as net from 'node:net';
import * as tls from 'node:tls';
import * as http from 'node:http';
import * as https from 'node:https';
import argon2 from 'argon2';
import { createDecipheriv } from 'node:crypto';

// ============ Encryption/Decryption for dev mode ============
const ENCRYPTED_PREFIX = 'enc:v1:';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

let _encryptionKey: Buffer | null = null;

function getEncryptionKey(): Buffer | null {
	if (_encryptionKey) return _encryptionKey;

	const dataDir = process.env.DATA_DIR || './data';
	const keyPath = join(dataDir, '.encryption_key');
	const envKey = process.env.ENCRYPTION_KEY;

	// Try file first
	if (existsSync(keyPath)) {
		try {
			_encryptionKey = readFileSync(keyPath);
			return _encryptionKey;
		} catch {
			// Fall through
		}
	}

	// Try env var
	if (envKey) {
		try {
			_encryptionKey = Buffer.from(envKey, 'base64');
			return _encryptionKey;
		} catch {
			// Fall through
		}
	}

	return null;
}

function decrypt(value: string | null | undefined): string | null {
	if (!value || !value.startsWith(ENCRYPTED_PREFIX)) {
		return value as string | null;
	}

	const key = getEncryptionKey();
	if (!key) {
		console.error('[vite.config] Cannot decrypt: no encryption key available');
		return value;
	}

	try {
		const payload = value.substring(ENCRYPTED_PREFIX.length);
		const combined = Buffer.from(payload, 'base64');

		if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
			return value;
		}

		const iv = combined.subarray(0, IV_LENGTH);
		const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
		const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

		const decipher = createDecipheriv('aes-256-gcm', key, iv);
		decipher.setAuthTag(authTag);

		const decrypted = Buffer.concat([
			decipher.update(ciphertext),
			decipher.final()
		]);

		return decrypted.toString('utf8');
	} catch (error) {
		console.error('[vite.config] Decryption failed:', error);
		return value;
	}
}

const WS_PORT = 5174;

// ============ Docker Target Types ============

interface DockerTarget {
	type: 'unix' | 'tcp' | 'hawser-edge';
	socket?: string;
	host?: string;
	port?: number;
	hawserToken?: string;
	environmentId?: number;
	// TLS configuration for mTLS connections
	tls?: {
		ca?: string;
		cert?: string;
		key?: string;
		rejectUnauthorized?: boolean;
	};
}

interface EnvironmentRow {
	id: number;
	is_local?: boolean | number;
	connection_type?: string;
	socket_path?: string;
	host?: string;
	port?: number;
	hawser_token?: string;
	protocol?: string;
	tls_ca?: string;
	tls_cert?: string;
	tls_key?: string;
	tls_skip_verify?: boolean | number;
}

// ============ Docker Target Resolution ============

function resolveDockerTarget(
	envId: number | undefined,
	getEnvironment: (id: number) => EnvironmentRow | null,
	defaultSocketPath: string
): DockerTarget {
	if (!envId) return { type: 'unix', socket: defaultSocketPath };

	const env = getEnvironment(envId);
	if (!env) return { type: 'unix', socket: defaultSocketPath };

	const isLocal = typeof env.is_local === 'boolean' ? env.is_local : Boolean(env.is_local);
	if (isLocal || env.connection_type === 'socket' || !env.connection_type) {
		return { type: 'unix', socket: env.socket_path || defaultSocketPath };
	}

	if (env.connection_type === 'hawser-edge') {
		return { type: 'hawser-edge', environmentId: envId };
	}

	// Build TLS config if using HTTPS protocol
	let tls: DockerTarget['tls'] | undefined;
	if (env.protocol === 'https') {
		tls = {
			rejectUnauthorized: !env.tls_skip_verify
		};
		if (env.tls_ca) tls.ca = env.tls_ca;
		if (env.tls_cert) tls.cert = env.tls_cert;
		// tls_key is encrypted in database - decrypt it
		if (env.tls_key) tls.key = decrypt(env.tls_key) || undefined;
	}

	// hawser_token is also encrypted
	const hawserToken = env.connection_type === 'hawser-standard' && env.hawser_token
		? decrypt(env.hawser_token) || undefined
		: undefined;

	return {
		type: 'tcp',
		host: env.host || 'localhost',
		port: env.port || 2375,
		hawserToken,
		tls
	};
}

// ============ Exec API Helpers ============

function buildExecStartHttpRequest(execId: string, target: DockerTarget): string {
	const body = JSON.stringify({ Detach: false, Tty: true });
	const tokenHeader = target.type === 'tcp' && target.hawserToken
		? `X-Hawser-Token: ${target.hawserToken}\r\n`
		: '';
	// Use actual host for proper routing through reverse proxies like Caddy
	const host = target.host || 'localhost';
	return `POST /exec/${execId}/start HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\n${tokenHeader}Connection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
}

// ============ Stream Processing ============

function processTerminalOutput(
	data: string,
	state: { headersStripped: boolean; isChunked: boolean }
): string | null {
	let text = data;

	if (!state.headersStripped) {
		if (text.toLowerCase().includes('transfer-encoding: chunked')) {
			state.isChunked = true;
		}
		const headerEnd = text.indexOf('\r\n\r\n');
		if (headerEnd > -1) {
			text = text.slice(headerEnd + 4);
			state.headersStripped = true;
		} else if (text.startsWith('HTTP/')) {
			return null;
		}
	}

	if (state.isChunked && text) {
		text = text.replace(/^[0-9a-fA-F]+\r\n/gm, '').replace(/\r\n$/g, '');
	}

	return text || null;
}

// ============ Hawser Edge Exec Messages ============

function createExecStartMessage(execId: string, containerId: string, shell: string, user: string, cols = 120, rows = 30) {
	return { type: 'exec_start', execId, containerId, cmd: shell, user, cols, rows };
}

function createExecInputMessage(execId: string, data: string) {
	return { type: 'exec_input', execId, data: Buffer.from(data).toString('base64') };
}

function createExecResizeMessage(execId: string, cols: number, rows: number) {
	return { type: 'exec_resize', execId, cols, rows };
}

function createExecEndMessage(execId: string, reason = 'user_closed') {
	return { type: 'exec_end', execId, reason };
}

// Get build info
function getGitCommit(): string | null {
	// Check COMMIT file (created by CI/CD before docker build)
	try {
		if (existsSync('COMMIT')) {
			const commit = readFileSync('COMMIT', 'utf-8').trim();
			if (commit && commit !== 'unknown') {
				return commit;
			}
		}
	} catch {
		// ignore
	}
	// Fall back to git command (local dev)
	try {
		return execSync('git rev-parse --short HEAD').toString().trim();
	} catch {
		return null;
	}
}

function getGitBranch(): string | null {
	// Check BRANCH file (created by CI/CD before docker build)
	try {
		if (existsSync('BRANCH')) {
			const branch = readFileSync('BRANCH', 'utf-8').trim();
			if (branch && branch !== 'unknown') {
				return branch;
			}
		}
	} catch {
		// ignore
	}
	// Fall back to git command (local dev)
	try {
		return execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
	} catch {
		return null;
	}
}

function getGitTag(): string | null {
	// First check env var (set by CI/CD via Docker build-arg)
	if (process.env.APP_VERSION) {
		return process.env.APP_VERSION;
	}
	// Check VERSION file (created by CI/CD before docker build)
	try {
		if (existsSync('VERSION')) {
			const version = readFileSync('VERSION', 'utf-8').trim();
			if (version && version !== 'unknown') {
				return version;
			}
		}
	} catch {
		// ignore
	}
	// Fall back to git tag (local dev)
	try {
		return execSync('git describe --tags --abbrev=0 2>/dev/null').toString().trim();
	} catch {
		return null;
	}
}

// Detect Docker socket path
function detectDockerSocket(): string {
	if (process.env.DOCKER_SOCKET && existsSync(process.env.DOCKER_SOCKET)) return process.env.DOCKER_SOCKET;
	if (process.env.DOCKER_HOST?.startsWith('unix://')) {
		const p = process.env.DOCKER_HOST.replace('unix://', '');
		if (existsSync(p)) return p;
	}
	const candidates = [
		'/var/run/docker.sock',
		join(homedir(), '.docker/run/docker.sock'),
		join(homedir(), '.orbstack/run/docker.sock'),
		'/run/docker.sock'
	];
	for (const s of candidates) {
		if (existsSync(s)) return s;
	}
	return '/var/run/docker.sock';
}

// Lazy database connection for environment lookup
let _db: Database | null = null;
function getDb(): Database | null {
	if (!_db) {
		// Database is in data/db/dockhand.db (same as main app)
		const dbPath = join(process.cwd(), 'data', 'db', 'dockhand.db');
		if (existsSync(dbPath)) {
			_db = new Database(dbPath, { readonly: true });
		}
	}
	return _db;
}

function getEnvironment(id: number): { host: string; port: number; is_local: boolean; connection_type?: string; hawser_token?: string } | null {
	const db = getDb();
	if (!db) return null;
	const row = db.prepare('SELECT * FROM environments WHERE id = ?').get(id) as any;
	return row ? { ...row, is_local: Boolean(row.is_local) } : null;
}

function getDockerTarget(envId?: number): DockerTarget {
	const dockerSocketPath = detectDockerSocket();
	return resolveDockerTarget(
		envId,
		(id) => getEnvironment(id) as EnvironmentRow | null,
		dockerSocketPath
	);
}

// Helper to make HTTP requests to Docker (supports Unix sockets and TCP with TLS)
function dockerHttpRequest(method: string, path: string, target: DockerTarget, body?: string): Promise<{ statusCode: number; body: string }> {
	return new Promise((resolve, reject) => {
		const headers: Record<string, string> = {};
		if (body) headers['Content-Type'] = 'application/json';
		if (target.hawserToken) headers['X-Hawser-Token'] = target.hawserToken;
		if (body) headers['Content-Length'] = Buffer.byteLength(body).toString();

		const opts: any = { method, headers, path };

		let req: any;
		if (target.type === 'unix') {
			opts.socketPath = target.socket;
			req = http.request(opts);
		} else if (target.tls) {
			opts.host = target.host;
			opts.port = target.port;
			opts.rejectUnauthorized = target.tls.rejectUnauthorized ?? true;
			if (target.tls.ca) opts.ca = [target.tls.ca, ...tls.rootCertificates];
			if (target.tls.cert) opts.cert = [target.tls.cert];
			if (target.tls.key) opts.key = target.tls.key;
			req = https.request(opts);
		} else {
			opts.host = target.host;
			opts.port = target.port;
			req = http.request(opts);
		}

		req.on('response', (res: any) => {
			let data = '';
			res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
			res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
		});
		req.on('error', reject);
		if (body) req.write(body);
		req.end();
	});
}

async function createExecForWs(containerId: string, cmd: string[], user: string, target: ReturnType<typeof getDockerTarget>): Promise<{ Id: string }> {
	const body = JSON.stringify({ AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true, Cmd: cmd, User: user });
	const res = await dockerHttpRequest('POST', '/containers/' + containerId + '/exec', target, body);
	if (res.statusCode !== 201) throw new Error('Failed to create exec: ' + res.body);
	return JSON.parse(res.body);
}

async function resizeExecForWs(execId: string, cols: number, rows: number, target: ReturnType<typeof getDockerTarget>): Promise<void> {
	try {
		await dockerHttpRequest('POST', '/exec/' + execId + '/resize?h=' + rows + '&w=' + cols, target);
	} catch {
		// Ignore resize errors
	}
}

// Map to track Docker streams per WebSocket (keyed by unique connection ID)
// Includes WebSocket reference for orphan detection
const dockerStreams = new Map<string, { stream: any; execId: string; target: ReturnType<typeof getDockerTarget>; state: { isChunked: boolean }; ws: any }>();

// Counter for unique WebSocket connection IDs
let wsConnectionCounter = 0;

// Map to track Edge exec sessions (execId -> frontend WebSocket)
const edgeExecSessions = new Map<string, { ws: any; execId: string; environmentId: number }>();

// Cleanup interval reference - only started in dev mode
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

// Cleanup function for orphaned sessions
function startCleanupInterval() {
	if (cleanupInterval) return; // Already running

	// Cleanup orphaned sessions every 5 minutes to prevent memory leaks
	// Only removes sessions where the WebSocket is no longer open (readyState !== 1)
	// This catches sessions where close handlers failed to fire
	cleanupInterval = setInterval(() => {
		let dockerCleaned = 0;
		let edgeCleaned = 0;

		for (const [connId, session] of dockerStreams.entries()) {
			// readyState: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
			if (session.ws?.readyState !== 1) {
				try {
					session.stream?.end?.();
				} catch { /* ignore */ }
				dockerStreams.delete(connId);
				dockerCleaned++;
			}
		}

		for (const [execId, session] of edgeExecSessions.entries()) {
			if (session.ws?.readyState !== 1) {
				edgeExecSessions.delete(execId);
				edgeCleaned++;
			}
		}

		if (dockerCleaned > 0 || edgeCleaned > 0) {
			console.log(`[WS Cleanup] Removed ${dockerCleaned} orphaned docker streams, ${edgeCleaned} orphaned edge sessions`);
		}

		// Maintain reconnection tracker: reset for stable connections, prune stale entries
		const now = Date.now();
		for (const [envId, tracker] of reconnectTracker) {
			const conn = edgeConnections.get(envId);
			if (conn && now - conn.lastHeartbeat < STABLE_THRESHOLD_MS) {
				reconnectTracker.delete(envId);
			} else if (!conn && tracker.timestamps.length > 0) {
				const lastAttempt = tracker.timestamps[tracker.timestamps.length - 1];
				if (now - lastAttempt > STALE_TRACKER_MS) {
					reconnectTracker.delete(envId);
				}
			}
		}
	}, 5 * 60 * 1000);
}

// Hawser Edge connection types (mirrors hawser.ts)
interface EdgeConnection {
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
	pendingRequests: Map<string, { resolve: Function; reject: Function; timeout: NodeJS.Timeout }>;
	pendingStreamRequests: Map<string, { onData: Function; onEnd: Function; onError: Function }>;
	pingInterval?: ReturnType<typeof setInterval>; // Server-side ping to keep connection alive through proxies
}

// Container event from edge agent (matches hawser.ts)
interface ContainerEventData {
	containerId: string;
	containerName?: string;
	image?: string;
	action: string;
	actorAttributes?: Record<string, string>;
	timestamp: string;
}

// Metrics data structure from Hawser agent
interface HawserMetrics {
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
}

// Use globalThis to share connections with hawser.ts module
declare global {
	var __hawserEdgeConnections: Map<number, EdgeConnection> | undefined;
	var __hawserSendMessage: ((envId: number, message: string) => boolean) | undefined;
	var __hawserHandleContainerEvent: ((envId: number, event: ContainerEventData) => Promise<void>) | undefined;
	var __hawserHandleMetrics: ((envId: number, metrics: HawserMetrics) => Promise<void>) | undefined;
}
const edgeConnections: Map<number, EdgeConnection> =
	globalThis.__hawserEdgeConnections ?? (globalThis.__hawserEdgeConnections = new Map());

// Function to send messages through the WebSocket (needed because ws.send must be called from vite context)
globalThis.__hawserSendMessage = (envId: number, message: string): boolean => {
	const conn = edgeConnections.get(envId);
	if (!conn || !conn.ws) {
		return false;
	}

	try {
		conn.ws.send(message);
		return true;
	} catch (e) {
		console.error(`[Hawser WS] sendMessage error:`, e);
		return false;
	}
};

// Map WebSocket to environmentId for quick lookup on close/message
const wsToEnvId = new Map<any, number>();

// WebSocket server for terminal connections and Hawser Edge in development mode
function webSocketPlugin(): Plugin {
	return {
		name: 'websocket',
		configureServer() {
			// Start cleanup interval for dev mode only
			startCleanupInterval();

			// Start Hawser auth fail cache cleanup (dev mode only, not during build)
			setInterval(() => {
				const now = Date.now();
				for (const [key, ts] of hawserAuthFailCache) {
					if (now - ts > HAWSER_AUTH_FAIL_COOLDOWN_MS) hawserAuthFailCache.delete(key);
				}
			}, 5 * 60_000);

			const dockerSocketPath = detectDockerSocket();
			console.log(`[Terminal WS] Detected Docker socket at: ${dockerSocketPath}`);

			// Start a ws WebSocket server on a separate port
			const httpServer = http.createServer((_req: any, res: any) => {
				res.writeHead(200);
				res.end('WebSocket server');
			});

			const wss = new WebSocketServer({ server: httpServer });

			// Per-connection metadata
			const wsMetadata = new Map<WsWebSocket, { url: string; connId?: string; edgeExecId?: string; remoteIp?: string }>();

			wss.on('connection', (ws: WsWebSocket, req: any) => {
				const url = new URL(req.url || '/', `http://localhost:${WS_PORT}`);
				const remoteIp = (req.headers?.['x-forwarded-for'] || '').split(',')[0].trim()
					|| req.socket?.remoteAddress
					|| 'unknown';
				const meta = { url: req.url || '/', remoteIp };
				wsMetadata.set(ws, meta);

				// Handle connection open logic
				(async () => {
					// Check if this is a Hawser Edge connection
					if (url.pathname === '/api/hawser/connect') {
						console.log('[Hawser WS] New connection pending authentication');
						return;
					}

					// Assign unique connection ID to this WebSocket
					const connId = `ws-${++wsConnectionCounter}`;
					meta.connId = connId;

					// Terminal connection handling
					const pathParts = url.pathname.split('/');
					const containerIdIndex = pathParts.indexOf('containers') + 1;
					const containerId = pathParts[containerIdIndex];

					const shell = url.searchParams.get('shell') || '/bin/sh';
					const user = url.searchParams.get('user') || 'root';
					const envIdParam = url.searchParams.get('envId');
					const envId = envIdParam ? parseInt(envIdParam, 10) : undefined;

					if (!containerId) {
						ws.send(JSON.stringify({ type: 'error', message: 'No container ID' }));
						ws.close();
						return;
					}

					const target = getDockerTarget(envId);

					try {
						// Handle Hawser Edge mode differently - use WebSocket protocol
						if (target.type === 'hawser-edge') {
							const conn = edgeConnections.get(target.environmentId);
							if (!conn) {
								ws.send(JSON.stringify({ type: 'error', message: 'Edge agent not connected' }));
								ws.close();
								return;
							}

							const execId = crypto.randomUUID();
							edgeExecSessions.set(execId, { ws, execId, environmentId: target.environmentId });
							meta.edgeExecId = execId;

							const execStartMsg = createExecStartMessage(execId, containerId, shell, user);
							conn.ws.send(JSON.stringify(execStartMsg));
							return;
						}

						// Direct Docker connection (unix or tcp/hawser-standard)
						const exec = await createExecForWs(containerId, [shell], user, target);
						const execId = exec.Id;

						let headersStripped = false;
						const state = { isChunked: false };

						// Create Node.js TCP/Unix socket connection to Docker
						let dockerStream: net.Socket;
						if (target.type === 'unix') {
							dockerStream = net.createConnection({ path: target.socket });
						} else if (target.type === 'tcp' && target.tls) {
							const tlsOpts: tls.ConnectionOptions = {
								host: target.host,
								port: target.port,
								servername: target.host,
								rejectUnauthorized: target.tls.rejectUnauthorized ?? true
							};
							if (target.tls.ca) tlsOpts.ca = [target.tls.ca, ...tls.rootCertificates];
							if (target.tls.cert) tlsOpts.cert = [target.tls.cert];
							if (target.tls.key) tlsOpts.key = target.tls.key;
							dockerStream = tls.connect(tlsOpts);
						} else {
							dockerStream = net.createConnection({ host: target.host, port: target.port });
						}

						dockerStream.on('connect', () => {
							const httpRequest = buildExecStartHttpRequest(execId, target);
							dockerStream.write(httpRequest);
						});

						dockerStream.on('data', (data: Buffer) => {
							if (ws.readyState === WsWebSocket.OPEN) {
								let text = data.toString('utf-8');
								if (!headersStripped) {
									if (text.toLowerCase().includes('transfer-encoding: chunked')) {
										state.isChunked = true;
									}
									const headerEnd = text.indexOf('\r\n\r\n');
									if (headerEnd > -1) {
										text = text.slice(headerEnd + 4);
										headersStripped = true;
									} else if (text.startsWith('HTTP/')) {
										return;
									}
								}
								if (state.isChunked && text) {
									text = text.replace(/^[0-9a-fA-F]+\r\n/gm, '').replace(/\r\n$/g, '');
								}
								if (text) {
									ws.send(JSON.stringify({ type: 'output', data: text }));
								}
							}
						});

						dockerStream.on('close', () => {
							if (ws.readyState === WsWebSocket.OPEN) {
								ws.send(JSON.stringify({ type: 'exit' }));
								ws.close();
							}
						});

						dockerStream.on('error', (error: Error) => {
							console.error('[Terminal WS] Socket error:', error?.message || error);
							if (ws.readyState === WsWebSocket.OPEN) {
								ws.send(JSON.stringify({ type: 'error', message: `Connection error: ${error?.message || 'Unknown error'}` }));
							}
						});

						dockerStreams.set(connId, { stream: dockerStream, execId, target, state, ws });
					} catch (error: any) {
						console.error('[Terminal WS] Connection error:', error?.message || error);
						ws.send(JSON.stringify({ type: 'error', message: error.message }));
						ws.close();
					}
				})();

				// Handle messages
				ws.on('message', async (message: Buffer | string) => {
					const meta = wsMetadata.get(ws);
					if (!meta) return;
					const wsUrl = new URL(meta.url, `http://localhost:${WS_PORT}`);

					// Handle Hawser Edge messages
					if (wsUrl.pathname === '/api/hawser/connect') {
						try {
							const messageStr = typeof message === 'string' ? message : message.toString('utf-8');
							const msg = JSON.parse(messageStr);
							await handleHawserMessage(ws, msg);
						} catch (error: any) {
							console.error('[Hawser WS] Error handling message:', error.message);
							ws.send(JSON.stringify({ type: 'error', error: error.message }));
						}
						return;
					}

					// Check if this is an Edge exec session
					const edgeExecId = meta.edgeExecId;
					if (edgeExecId) {
						const session = edgeExecSessions.get(edgeExecId);
						if (session) {
							const conn = edgeConnections.get(session.environmentId);
							if (conn) {
								try {
									const msg = JSON.parse(message.toString());
									if (msg.type === 'input') {
										conn.ws.send(JSON.stringify(createExecInputMessage(edgeExecId, msg.data)));
									} else if (msg.type === 'resize') {
										conn.ws.send(JSON.stringify(createExecResizeMessage(edgeExecId, msg.cols, msg.rows)));
									}
								} catch (e) {
									console.error('[Terminal WS] Error handling Edge message:', e);
								}
							}
						}
						return;
					}

					// Terminal message handling (direct Docker connection)
					const connId = meta.connId;
					if (!connId) return;
					const d = dockerStreams.get(connId);
					if (!d) return;

					try {
						const msg = JSON.parse(message.toString());
						if (msg.type === 'input' && d.stream) {
							d.stream.write(msg.data);
						} else if (msg.type === 'resize' && d.execId) {
							resizeExecForWs(d.execId, msg.cols, msg.rows, d.target);
						}
					} catch {
						if (d.stream) {
							d.stream.write(message);
						}
					}
				});

				// Handle close
				ws.on('close', () => {
					const meta = wsMetadata.get(ws);
					wsMetadata.delete(ws);

					// Check if it's a Hawser connection
					const envId = wsToEnvId.get(ws);
					if (envId) {
						const conn = edgeConnections.get(envId);
						if (conn) {
							console.log(`[Hawser WS] Agent disconnected: ${conn.agentId}`);
							if (conn.pingInterval) {
								clearInterval(conn.pingInterval);
								conn.pingInterval = undefined;
							}
							for (const [, pending] of conn.pendingRequests) {
								clearTimeout(pending.timeout);
								pending.reject(new Error('Connection closed'));
							}
							for (const [, pending] of conn.pendingStreamRequests) {
								pending.onEnd('Connection closed');
							}
							edgeConnections.delete(envId);
						}
						wsToEnvId.delete(ws);
						return;
					}

					// Check if it's an Edge exec session
					const edgeExecId = meta?.edgeExecId;
					if (edgeExecId) {
						const session = edgeExecSessions.get(edgeExecId);
						if (session) {
							const conn = edgeConnections.get(session.environmentId);
							if (conn) {
								conn.ws.send(JSON.stringify(createExecEndMessage(edgeExecId)));
							}
							edgeExecSessions.delete(edgeExecId);
							console.log(`[Terminal WS] Edge exec session closed: ${edgeExecId}`);
						}
						return;
					}

					// Terminal connection cleanup (direct Docker)
					const connId = meta?.connId;
					if (connId) {
						const d = dockerStreams.get(connId);
						if (d?.stream) {
							d.stream.end();
						}
						dockerStreams.delete(connId);
					}
				});
			});

			httpServer.listen(WS_PORT, () => {
				console.log(`[Terminal WS] WebSocket server running on port ${WS_PORT}`);
			});
		}
	};
}

// Rate limiter for failed Hawser token auth (dev mode)
const hawserAuthFailCache = new Map<string, number>();
const HAWSER_AUTH_FAIL_COOLDOWN_MS = 5 * 60_000; // 5 minutes

// ─── Reconnection storm throttle (mirrors hawser.ts) ───
interface ReconnectTrackerEntry {
	timestamps: number[];
	cooldownUntil: number;
	cooldownLevel: number;
}
const reconnectTracker = new Map<number, ReconnectTrackerEntry>();
const RECONNECT_WINDOW_MS = 2 * 60 * 1000;
const RECONNECT_BURST = 3;
const COOLDOWN_LEVELS_SECS = [30, 60, 120, 300];
const STABLE_THRESHOLD_MS = 5 * 60 * 1000;
const STALE_TRACKER_MS = 10 * 60 * 1000;

function recordReconnection(envId: number): { allowed: true } | { allowed: false; retryAfter: number } {
	const now = Date.now();
	let entry = reconnectTracker.get(envId);

	if (!entry) {
		entry = { timestamps: [now], cooldownUntil: 0, cooldownLevel: 0 };
		reconnectTracker.set(envId, entry);
		return { allowed: true };
	}

	if (now < entry.cooldownUntil) {
		const retryAfter = Math.ceil((entry.cooldownUntil - now) / 1000);
		return { allowed: false, retryAfter };
	}

	entry.timestamps = entry.timestamps.filter(ts => now - ts < RECONNECT_WINDOW_MS);
	entry.timestamps.push(now);

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

// Handle Hawser Edge protocol messages
async function handleHawserMessage(ws: any, msg: any) {
	if (msg.type === 'hello') {
		const agentId = msg.agentId || 'unknown';
		console.log(`[Hawser WS] Hello from agent: ${msg.agentName} (${agentId})`);

		// Rate-limit by remote IP (not agentId which is attacker-controlled)
		const meta = wsMetadata.get(ws);
		const rateLimitKey = meta?.remoteIp || agentId;
		const lastFail = hawserAuthFailCache.get(rateLimitKey);
		if (lastFail && (Date.now() - lastFail) < HAWSER_AUTH_FAIL_COOLDOWN_MS) {
			ws.send(JSON.stringify({ type: 'error', error: 'Rate limited - retry later' }));
			ws.close();
			return;
		}

		// In dev mode, we need to validate the token against the database
		const db = getDb();
		if (!db) {
			ws.send(JSON.stringify({ type: 'error', error: 'Database not available' }));
			ws.close();
			return;
		}

		// Fast path: lookup by token prefix (first 8 chars) instead of iterating all tokens.
		// This reduces O(N) Argon2id verifications to O(1) DB lookup + 1 verify.
		const prefix = msg.token.substring(0, 8);
		const candidates = db.prepare(
			'SELECT * FROM hawser_tokens WHERE token_prefix = ? AND is_active = 1'
		).all(prefix) as any[];

		let matchedToken: any = null;
		for (const t of candidates) {
			try {
				const isValid = await argon2.verify(t.token, msg.token);
				if (isValid) {
					matchedToken = t;
					break;
				}
			} catch {
				// Invalid hash format, skip
			}
		}

		if (!matchedToken) {
			console.log(`[Hawser WS] Invalid token (IP: ${rateLimitKey})`);
			hawserAuthFailCache.set(rateLimitKey, Date.now());
			ws.send(JSON.stringify({ type: 'error', error: 'Invalid token' }));
			ws.close();
			return;
		}
		// Clear any previous failure on successful auth
		hawserAuthFailCache.delete(rateLimitKey);

		const environmentId = matchedToken.environment_id;

		// Throttle reconnection storms
		const throttle = recordReconnection(environmentId);
		if (!throttle.allowed) {
			console.log(`[Hawser WS] Throttling reconnection for env ${environmentId}: retry after ${throttle.retryAfter}s`);
			ws.send(JSON.stringify({
				type: 'error',
				error: `Reconnection throttled. Retry after ${throttle.retryAfter}s.`,
				retryAfter: throttle.retryAfter
			}));
			ws.close();
			return;
		}

		// Update environment with agent info
		try {
			db.prepare(`UPDATE environments SET
				hawser_last_seen = datetime('now'),
				hawser_agent_id = ?,
				hawser_agent_name = ?,
				hawser_version = ?,
				hawser_capabilities = ?
			WHERE id = ?`).run(
				msg.agentId,
				msg.agentName,
				msg.version,
				JSON.stringify(msg.capabilities || []),
				environmentId
			);
		} catch (e) {
			// Read-only DB in dev mode, ignore
		}

		// Close any existing connection for this environment
		const existing = edgeConnections.get(environmentId);
		if (existing) {
			const pendingCount = existing.pendingRequests.size;
			const streamCount = existing.pendingStreamRequests.size;
			console.log(
				`[Hawser WS] Replacing existing connection for environment ${environmentId}. ` +
				`Rejecting ${pendingCount} pending requests and ${streamCount} stream requests.`
			);

			// Reject all pending requests before closing
			for (const [requestId, pending] of existing.pendingRequests) {
				console.log(`[Hawser WS] Rejecting pending request ${requestId} due to connection replacement`);
				clearTimeout(pending.timeout);
				pending.reject(new Error('Connection replaced by new agent'));
			}
			for (const [requestId, pending] of existing.pendingStreamRequests) {
				console.log(`[Hawser WS] Ending stream request ${requestId} due to connection replacement`);
				pending.onEnd?.('Connection replaced by new agent');
			}
			existing.pendingRequests.clear();
			existing.pendingStreamRequests.clear();

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
			wsToEnvId.delete(existing.ws);
		}

		// Store connection in shared map (accessible by hawser.ts via globalThis)
		const connection: EdgeConnection = {
			ws,
			environmentId,
			agentId: msg.agentId,
			agentName: msg.agentName,
			agentVersion: msg.version || 'unknown',
			dockerVersion: msg.dockerVersion || 'unknown',
			hostname: msg.hostname || 'unknown',
			capabilities: msg.capabilities || [],
			connectedAt: new Date(),
			lastHeartbeat: Date.now(),
			pendingRequests: new Map(),
			pendingStreamRequests: new Map()
		};

		edgeConnections.set(environmentId, connection);
		wsToEnvId.set(ws, environmentId);

		// Send welcome
		ws.send(JSON.stringify({
			type: 'welcome',
			environmentId,
			message: `Welcome ${msg.agentName}! Connected to Dockhand dev server.`
		}));

		// Note: server-side ping interval is managed by hawser.ts handleEdgeConnection()
		// via the shared edgeConnections map — no duplicate interval needed here.

		console.log(`[Hawser WS] Agent ${msg.agentName} connected for environment ${environmentId}`);
	} else if (msg.type === 'ping') {
		// Agent sent ping - respond with pong to keep connection alive
		const envId = wsToEnvId.get(ws);
		if (envId) {
			const conn = edgeConnections.get(envId);
			if (conn) {
				conn.lastHeartbeat = Date.now();
			}
		}
		ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
	} else if (msg.type === 'pong') {
		// Heartbeat response - update last seen
		const envId = wsToEnvId.get(ws);
		if (envId) {
			const conn = edgeConnections.get(envId);
			if (conn) {
				conn.lastHeartbeat = Date.now();
			}
		}
	} else if (msg.type === 'response') {
		// Response to a request we sent
		const envId = wsToEnvId.get(ws);
		if (envId) {
			const conn = edgeConnections.get(envId);
			if (conn) {
				const pending = conn.pendingRequests.get(msg.requestId);
				if (pending) {
					clearTimeout(pending.timeout);
					conn.pendingRequests.delete(msg.requestId);

					// Body is now a string (either plain text/JSON or base64-encoded binary)
					// isBinary flag indicates if base64 decoding is needed
					pending.resolve({
						statusCode: msg.statusCode,
						headers: msg.headers || {},
						body: msg.body || '',
						isBinary: msg.isBinary || false
					});
				}
			}
		}
	} else if (msg.type === 'stream') {
		// Streaming data from agent
		const envId = wsToEnvId.get(ws);
		if (!envId) {
			console.warn(`[Hawser WS] Stream data from unknown WebSocket, requestId=${msg.requestId}`);
			return;
		}
		const conn = edgeConnections.get(envId);
		if (!conn) {
			console.warn(`[Hawser WS] Stream data for unknown environment ${envId}, requestId=${msg.requestId}`);
			return;
		}
		const pending = conn.pendingStreamRequests?.get(msg.requestId);
		if (!pending) {
			console.warn(`[Hawser WS] Stream data for unknown request ${msg.requestId} on env ${envId}`);
			return;
		}
		pending.onData(msg.data, msg.stream);
	} else if (msg.type === 'stream_end') {
		// Stream ended
		const envId = wsToEnvId.get(ws);
		if (!envId) {
			console.warn(`[Hawser WS] Stream end from unknown WebSocket, requestId=${msg.requestId}`);
			return;
		}
		const conn = edgeConnections.get(envId);
		if (!conn) {
			console.warn(`[Hawser WS] Stream end for unknown environment ${envId}, requestId=${msg.requestId}`);
			return;
		}
		const pending = conn.pendingStreamRequests.get(msg.requestId);
		if (!pending) {
			console.warn(`[Hawser WS] Stream end for unknown request ${msg.requestId} on env ${envId}`);
			return;
		}
		conn.pendingStreamRequests.delete(msg.requestId);
		pending.onEnd(msg.reason);
	} else if (msg.type === 'metrics') {
		// Metrics from agent - save to database for dashboard graphs
		const envId = wsToEnvId.get(ws);
		if (envId && msg.metrics) {
			if (globalThis.__hawserHandleMetrics) {
				globalThis.__hawserHandleMetrics(envId, msg.metrics).catch((err) => {
					console.error(`[Hawser WS] Error saving metrics:`, err);
				});
			}
		}
	} else if (msg.type === 'exec_ready') {
		// Exec session is ready
		const session = edgeExecSessions.get(msg.execId);
		if (session?.ws?.readyState === 1) {
			console.log(`[Hawser WS] Exec ready: ${msg.execId}`);
			// Frontend doesn't need explicit ready message, it's already waiting for output
		}
	} else if (msg.type === 'exec_output') {
		// Terminal output from exec session
		const session = edgeExecSessions.get(msg.execId);
		if (session?.ws?.readyState === 1) {
			// Decode base64 data
			const data = Buffer.from(msg.data, 'base64').toString('utf-8');
			session.ws.send(JSON.stringify({ type: 'output', data }));
		}
	} else if (msg.type === 'exec_end') {
		// Exec session ended
		const session = edgeExecSessions.get(msg.execId);
		if (session) {
			console.log(`[Hawser WS] Exec ended: ${msg.execId} (reason: ${msg.reason})`);
			if (session.ws?.readyState === 1) {
				session.ws.send(JSON.stringify({ type: 'exit' }));
				session.ws.close();
			}
			edgeExecSessions.delete(msg.execId);
		}
	} else if (msg.type === 'container_event') {
		// Container event from edge agent
		const envId = wsToEnvId.get(ws);
		if (envId && msg.event) {
			// Call the global handler registered by hawser.ts
			if (globalThis.__hawserHandleContainerEvent) {
				globalThis.__hawserHandleContainerEvent(envId, msg.event).catch((err) => {
					console.error('[Hawser WS] Error handling container event:', err);
				});
			}
		}
	} else if (msg.type === 'error' && msg.requestId) {
		// Error might be for an exec session
		const session = edgeExecSessions.get(msg.requestId);
		if (session?.ws?.readyState === 1) {
			console.error(`[Hawser WS] Exec error: ${msg.error}`);
			session.ws.send(JSON.stringify({ type: 'error', message: msg.error }));
			session.ws.close();
			edgeExecSessions.delete(msg.requestId);
		}
	}
}

export default defineConfig({
	plugins: [tailwindcss(), sveltekit(), webSocketPlugin()],
	define: {
		__BUILD_DATE__: JSON.stringify(new Date().toISOString()),
		__BUILD_COMMIT__: JSON.stringify(getGitCommit()),
		__BUILD_BRANCH__: JSON.stringify(getGitBranch()),
		__APP_VERSION__: JSON.stringify(getGitTag())
	},
	optimizeDeps: {
		include: ['lucide-svelte', '@xterm/xterm', '@xterm/addon-fit']
	},
	resolve: {
		dedupe: [
			'@codemirror/state',
			'@codemirror/view',
			'@codemirror/language',
			'@lezer/common',
			'@lezer/highlight'
		]
	},
	build: {
		target: 'esnext',
		minify: 'esbuild',
		sourcemap: false
	}
});
