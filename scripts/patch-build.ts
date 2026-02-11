/**
 * Post-build script to fix svelte-adapter-bun WebSocket issue
 * The adapter calls server.websocket() which doesn't exist in SvelteKit.
 *
 * IMPORTANT: Terminal WebSocket logic is shared with vite.config.ts
 * Core functions like resolveDockerTarget are defined in:
 *   src/lib/server/ws-terminal-shared.ts
 *
 * When updating WebSocket terminal handling, update the shared module
 * and this file will use the same logic at build time.
 */

import { join } from 'node:path';

const BUILD_DIR = join(import.meta.dir, '../build');

async function patchHandler() {
	const handlerPath = join(BUILD_DIR, 'handler.js');
	const handlerFile = Bun.file(handlerPath);

	if (!await handlerFile.exists()) {
		console.error('handler.js not found');
		process.exit(1);
	}

	let content = await handlerFile.text();

	// Replace broken server.websocket() call
	content = content.replace(
		'const websocket = server.websocket();',
		'const websocket = null;'
	);

	// Add WebSocket upgrade detection before ssr handler
	const ssrIndex = content.indexOf('var ssr = async (request, bunServer) => {');
	if (ssrIndex > -1) {
		const upgradeCode = `
var handleUpgrade = (request, bunServer) => {
	const url = new URL(request.url);
	const isUpgrade = request.headers.get('connection')?.toLowerCase().includes('upgrade') &&
		request.headers.get('upgrade')?.toLowerCase() === 'websocket';
	if (!isUpgrade) return null;

	// Handle terminal exec WebSocket
	if (url.pathname.includes('/api/containers/') && url.pathname.includes('/exec')) {
		const pathParts = url.pathname.split('/');
		const containerIdIndex = pathParts.indexOf('containers') + 1;
		const containerId = pathParts[containerIdIndex];
		const shell = url.searchParams.get('shell') || '/bin/sh';
		const user = url.searchParams.get('user') || 'root';
		const envId = url.searchParams.get('envId') ? parseInt(url.searchParams.get('envId'), 10) : undefined;
		if (bunServer.upgrade(request, { data: { type: 'terminal', containerId, shell, user, envId } })) {
			return new Response(null, { status: 101 });
		}
	}

	// Handle Hawser Edge WebSocket
	if (url.pathname === '/api/hawser/connect') {
		if (bunServer.upgrade(request, { data: { type: 'hawser' } })) {
			return new Response(null, { status: 101 });
		}
	}

	return null;
};
`;
		content = content.slice(0, ssrIndex) + upgradeCode + content.slice(ssrIndex);
	}

	// Modify handler to check for upgrade first
	content = content.replace(
		'return ssr(request, server2);',
		'const upgradeResponse = handleUpgrade(request, server2); if (upgradeResponse) return upgradeResponse; return ssr(request, server2);'
	);

	await Bun.write(handlerPath, content);
	console.log('✓ Patched handler.js');
}

async function patchIndex() {
	const indexPath = join(BUILD_DIR, 'index.js');
	const indexFile = Bun.file(indexPath);

	if (!await indexFile.exists()) {
		console.error('index.js not found');
		process.exit(1);
	}

	let content = await indexFile.text();

	const wsHandler = `
import { existsSync as _existsSync, readFileSync as _readFileSync } from 'fs';
import { homedir as _homedir } from 'os';
import { Database as _Database } from 'bun:sqlite';
import { SQL as _SQL } from 'bun';
import { join as _join } from 'path';
import { createDecipheriv as _createDecipheriv } from 'node:crypto';

// Encryption/decryption for sensitive fields
const _ENCRYPTED_PREFIX = 'enc:v1:';
const _IV_LENGTH = 12;
const _AUTH_TAG_LENGTH = 16;
let _encryptionKey = null;

function _getEncryptionKey() {
	if (_encryptionKey) return _encryptionKey;
	const dataDir = process.env.DATA_DIR || _join(process.cwd(), 'data');
	const keyPath = _join(dataDir, '.encryption_key');
	const envKey = process.env.ENCRYPTION_KEY;
	if (_existsSync(keyPath)) {
		try {
			_encryptionKey = _readFileSync(keyPath);
			return _encryptionKey;
		} catch {}
	}
	if (envKey) {
		try {
			_encryptionKey = Buffer.from(envKey, 'base64');
			return _encryptionKey;
		} catch {}
	}
	return null;
}

function _decrypt(value) {
	if (!value || !value.startsWith(_ENCRYPTED_PREFIX)) return value;
	const key = _getEncryptionKey();
	if (!key) { console.error('[WS] Cannot decrypt: no encryption key'); return value; }
	try {
		const payload = value.substring(_ENCRYPTED_PREFIX.length);
		const combined = Buffer.from(payload, 'base64');
		if (combined.length < _IV_LENGTH + _AUTH_TAG_LENGTH + 1) return value;
		const iv = combined.subarray(0, _IV_LENGTH);
		const authTag = combined.subarray(_IV_LENGTH, _IV_LENGTH + _AUTH_TAG_LENGTH);
		const ciphertext = combined.subarray(_IV_LENGTH + _AUTH_TAG_LENGTH);
		const decipher = _createDecipheriv('aes-256-gcm', key, iv);
		decipher.setAuthTag(authTag);
		return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
	} catch (e) { console.error('[WS] Decryption failed:', e); return value; }
}

// Database connection (supports both SQLite and PostgreSQL)
let _db = null;
let _isPostgres = false;
function _getDb() {
	if (!_db) {
		const dbUrl = process.env.DATABASE_URL;
		if (dbUrl && (dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://'))) {
			_db = new _SQL(dbUrl);
			_isPostgres = true;
		} else {
			const _dbPath = process.env.DATA_DIR ? _join(process.env.DATA_DIR, 'db', 'dockhand.db') : _join(process.cwd(), 'data', 'db', 'dockhand.db');
			if (_existsSync(_dbPath)) {
				_db = new _Database(_dbPath);
			}
		}
	}
	return _db;
}

async function _getEnvironment(id) {
	const db = _getDb();
	if (!db) return null;
	let row;
	if (_isPostgres) {
		const result = await db.unsafe('SELECT * FROM environments WHERE id = $1', [id]);
		row = result[0];
	} else {
		row = db.prepare('SELECT * FROM environments WHERE id = ?').get(id);
	}
	return row ? { ...row, is_local: Boolean(row.is_local), connection_type: row.connection_type, hawser_token: row.hawser_token } : null;
}

function detectDockerSocket() {
	if (process.env.DOCKER_SOCKET && _existsSync(process.env.DOCKER_SOCKET)) return process.env.DOCKER_SOCKET;
	if (process.env.DOCKER_HOST?.startsWith('unix://')) {
		const p = process.env.DOCKER_HOST.replace('unix://', '');
		if (_existsSync(p)) return p;
	}
	for (const s of ['/var/run/docker.sock', _homedir() + '/.docker/run/docker.sock', _homedir() + '/.orbstack/run/docker.sock', '/run/docker.sock']) {
		if (_existsSync(s)) return s;
	}
	return '/var/run/docker.sock';
}
const dockerSocketPath = detectDockerSocket();
console.log('Detected Docker socket at:', dockerSocketPath);

const dockerStreams = new Map();
let _wsConnCounter = 0;

async function _getDockerTarget(envId) {
	if (!envId) return { type: 'unix', socket: dockerSocketPath };
	const env = await _getEnvironment(envId);
	if (!env) return { type: 'unix', socket: dockerSocketPath };
	// Check for socket connection type (local Unix socket)
	if (env.is_local || env.connection_type === 'socket' || !env.connection_type) {
		return { type: 'unix', socket: env.socket_path || dockerSocketPath };
	}
	if (env.connection_type === 'hawser-edge') return { type: 'hawser-edge', environmentId: envId };
	// Build TLS config if using HTTPS
	const protocol = env.protocol || 'http';
	const useTls = protocol === 'https';
	let tls = null;
	if (useTls) {
		tls = {
			rejectUnauthorized: !env.tls_skip_verify,
			ca: env.tls_ca || undefined,
			cert: env.tls_cert || undefined,
			// tls_key is encrypted - decrypt it
			key: _decrypt(env.tls_key) || undefined
		};
	}
	// hawser_token is also encrypted
	const hawserToken = env.connection_type === 'hawser-standard' && env.hawser_token
		? _decrypt(env.hawser_token) || undefined
		: undefined;
	return {
		type: useTls ? 'tls' : 'tcp',
		host: env.host,
		port: env.port || 2375,
		hawserToken,
		tls
	};
}

async function createExec(containerId, cmd, user, target) {
	const headers = { 'Content-Type': 'application/json' };
	const fetchOpts = {
		method: 'POST',
		headers,
		body: JSON.stringify({ AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true, Cmd: cmd, User: user })
	};
	let url;
	if (target.type === 'unix') {
		url = 'http://localhost/containers/' + containerId + '/exec';
		fetchOpts.unix = target.socket;
	} else {
		const protocol = target.type === 'tls' ? 'https' : 'http';
		url = protocol + '://' + target.host + ':' + target.port + '/containers/' + containerId + '/exec';
		if (target.hawserToken) headers['X-Hawser-Token'] = target.hawserToken;
		if (target.tls) {
			fetchOpts.tls = {
				sessionTimeout: 0,
				servername: target.host,
				rejectUnauthorized: target.tls.rejectUnauthorized
			};
			if (target.tls.ca) fetchOpts.tls.ca = [target.tls.ca];
			if (target.tls.cert) fetchOpts.tls.cert = [target.tls.cert];
			if (target.tls.key) fetchOpts.tls.key = target.tls.key;
			fetchOpts.keepalive = false;
		}
	}
	const res = await fetch(url, fetchOpts);
	if (!res.ok) throw new Error('Failed to create exec: ' + (await res.text()));
	return res.json();
}

async function resizeExec(execId, cols, rows, target) {
	try {
		const fetchOpts = { method: 'POST' };
		let url;
		if (target.type === 'unix') {
			url = 'http://localhost/exec/' + execId + '/resize?h=' + rows + '&w=' + cols;
			fetchOpts.unix = target.socket;
		} else {
			const protocol = target.type === 'tls' ? 'https' : 'http';
			url = protocol + '://' + target.host + ':' + target.port + '/exec/' + execId + '/resize?h=' + rows + '&w=' + cols;
			if (target.hawserToken) fetchOpts.headers = { 'X-Hawser-Token': target.hawserToken };
			if (target.tls) {
				fetchOpts.tls = {
					sessionTimeout: 0,
					servername: target.host,
					rejectUnauthorized: target.tls.rejectUnauthorized
				};
				if (target.tls.ca) fetchOpts.tls.ca = [target.tls.ca];
				if (target.tls.cert) fetchOpts.tls.cert = [target.tls.cert];
				if (target.tls.key) fetchOpts.tls.key = target.tls.key;
				fetchOpts.keepalive = false;
			}
		}
		await fetch(url, fetchOpts);
	} catch {}
}

// ============ Hawser Edge Support ============
// Global edge connections map (shared with hawser.ts via globalThis)
if (!globalThis.__hawserEdgeConnections) globalThis.__hawserEdgeConnections = new Map();
const _edgeConnections = globalThis.__hawserEdgeConnections;

// Map WebSocket to environmentId for quick lookup
const _wsToEnvId = new Map();

// Edge exec sessions (execId -> frontend WebSocket)
const _edgeExecSessions = new Map();

// Validate Hawser token against database
async function _validateHawserToken(token) {
	const db = _getDb();
	if (!db) return { valid: false };
	let tokens;
	if (_isPostgres) {
		tokens = await db.unsafe('SELECT * FROM hawser_tokens WHERE is_active = true');
	} else {
		tokens = db.prepare('SELECT * FROM hawser_tokens WHERE is_active = 1').all();
	}
	for (const t of tokens) {
		try {
			const isValid = await Bun.password.verify(token, t.token);
			if (isValid) {
				if (_isPostgres) {
					await db.unsafe('UPDATE hawser_tokens SET last_used = NOW() WHERE id = $1', [t.id]);
				} else {
					db.prepare('UPDATE hawser_tokens SET last_used = datetime(\\'now\\') WHERE id = ?').run(t.id);
				}
				return { valid: true, environmentId: t.environment_id, tokenId: t.id };
			}
		} catch {}
	}
	return { valid: false };
}

// Update environment status in database
async function _updateEnvStatus(envId, conn) {
	const db = _getDb();
	if (!db) return;
	try {
		if (conn) {
			if (_isPostgres) {
				await db.unsafe('UPDATE environments SET hawser_last_seen = NOW(), hawser_agent_id = $1, hawser_agent_name = $2, hawser_version = $3, hawser_capabilities = $4 WHERE id = $5',
					[conn.agentId, conn.agentName, conn.agentVersion, JSON.stringify(conn.capabilities || []), envId]);
			} else {
				db.prepare('UPDATE environments SET hawser_last_seen = datetime(\\'now\\'), hawser_agent_id = ?, hawser_agent_name = ?, hawser_version = ?, hawser_capabilities = ? WHERE id = ?')
					.run(conn.agentId, conn.agentName, conn.agentVersion, JSON.stringify(conn.capabilities || []), envId);
			}
		} else {
			if (_isPostgres) {
				await db.unsafe('UPDATE environments SET hawser_last_seen = NOW() WHERE id = $1', [envId]);
			} else {
				db.prepare('UPDATE environments SET hawser_last_seen = datetime(\\'now\\') WHERE id = ?').run(envId);
			}
		}
	} catch {}
}

// Handle Hawser Edge protocol messages
async function _handleHawserMessage(ws, msg) {
	if (msg.type === 'hello') {
		console.log('[Hawser] Hello from agent:', msg.agentName, '(' + msg.agentId + ')');
		const validation = await _validateHawserToken(msg.token);
		if (!validation.valid) {
			console.log('[Hawser] Invalid token');
			ws.send(JSON.stringify({ type: 'error', error: 'Invalid token' }));
			ws.close();
			return;
		}
		const envId = validation.environmentId;
		const existing = _edgeConnections.get(envId);
		if (existing) {
			const pendingCount = existing.pendingRequests.size;
			const streamCount = existing.pendingStreamRequests.size;
			console.log('[Hawser] Replacing existing connection for env', envId, '- rejecting', pendingCount, 'pending requests and', streamCount, 'stream requests');
			// Reject all pending requests before closing
			for (const [requestId, pending] of existing.pendingRequests) {
				clearTimeout(pending.timeout);
				pending.reject(new Error('Connection replaced by new agent'));
			}
			for (const [requestId, pending] of existing.pendingStreamRequests) {
				pending.onEnd?.('Connection replaced by new agent');
			}
			existing.pendingRequests.clear();
			existing.pendingStreamRequests.clear();
			existing.ws.close(1000, 'Replaced');
			_wsToEnvId.delete(existing.ws);
		}
		const conn = {
			ws, environmentId: envId, agentId: msg.agentId, agentName: msg.agentName,
			agentVersion: msg.version || 'unknown', dockerVersion: msg.dockerVersion || 'unknown',
			hostname: msg.hostname || 'unknown', capabilities: msg.capabilities || [],
			connectedAt: new Date(), lastHeartbeat: new Date(),
			pendingRequests: new Map(), pendingStreamRequests: new Map(),
			pingInterval: null
		};
		_edgeConnections.set(envId, conn);
		_wsToEnvId.set(ws, envId);
		await _updateEnvStatus(envId, conn);
		ws.send(JSON.stringify({ type: 'welcome', environmentId: envId, message: 'Connected to Dockhand' }));
		// Start server-side ping interval to keep connection alive through Traefik/proxies (5s)
		conn.pingInterval = setInterval(() => {
			try { ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() })); }
			catch { if (conn.pingInterval) { clearInterval(conn.pingInterval); conn.pingInterval = null; } }
		}, 5000);
		console.log('[Hawser] Agent', msg.agentName, 'connected for env', envId);
	} else if (msg.type === 'ping') {
		const envId = _wsToEnvId.get(ws);
		if (envId) { const c = _edgeConnections.get(envId); if (c) c.lastHeartbeat = new Date(); }
		ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
	} else if (msg.type === 'pong') {
		const envId = _wsToEnvId.get(ws);
		if (envId) { const c = _edgeConnections.get(envId); if (c) c.lastHeartbeat = new Date(); }
	} else if (msg.type === 'response') {
		const envId = _wsToEnvId.get(ws);
		if (!envId) {
			console.warn('[Hawser] Response from unknown WebSocket, requestId=' + msg.requestId);
			return;
		}
		const conn = _edgeConnections.get(envId);
		if (conn) {
			const pending = conn.pendingRequests.get(msg.requestId);
			if (pending) {
				clearTimeout(pending.timeout);
				conn.pendingRequests.delete(msg.requestId);
				pending.resolve({ statusCode: msg.statusCode, headers: msg.headers || {}, body: msg.body || '', isBinary: msg.isBinary || false });
			} else {
				console.warn('[Hawser] Response for unknown request ' + msg.requestId + ' on env ' + envId);
			}
		}
	} else if (msg.type === 'stream') {
		const envId = _wsToEnvId.get(ws);
		if (!envId) {
			console.warn('[Hawser] Stream data from unknown WebSocket, requestId=' + msg.requestId);
			return;
		}
		const conn = _edgeConnections.get(envId);
		if (conn?.pendingStreamRequests) {
			const pending = conn.pendingStreamRequests.get(msg.requestId);
			if (pending) {
				pending.onData(msg.data, msg.stream);
			} else {
				console.warn('[Hawser] Stream data for unknown request ' + msg.requestId + ' on env ' + envId);
			}
		}
	} else if (msg.type === 'stream_end') {
		const envId = _wsToEnvId.get(ws);
		if (!envId) {
			console.warn('[Hawser] Stream end from unknown WebSocket, requestId=' + msg.requestId);
			return;
		}
		const conn = _edgeConnections.get(envId);
		if (conn?.pendingStreamRequests) {
			const pending = conn.pendingStreamRequests.get(msg.requestId);
			if (pending) {
				conn.pendingStreamRequests.delete(msg.requestId);
				pending.onEnd(msg.reason);
			} else {
				console.warn('[Hawser] Stream end for unknown request ' + msg.requestId + ' on env ' + envId);
			}
		}
	} else if (msg.type === 'exec_ready') {
		const session = _edgeExecSessions.get(msg.execId);
		if (session?.ws?.readyState === 1) console.log('[Hawser] Exec ready:', msg.execId);
	} else if (msg.type === 'exec_output') {
		const session = _edgeExecSessions.get(msg.execId);
		if (session?.ws?.readyState === 1) {
			const data = Buffer.from(msg.data, 'base64').toString('utf-8');
			session.ws.send(JSON.stringify({ type: 'output', data }));
		}
	} else if (msg.type === 'exec_end') {
		const session = _edgeExecSessions.get(msg.execId);
		if (session) {
			console.log('[Hawser] Exec ended:', msg.execId);
			if (session.ws?.readyState === 1) { session.ws.send(JSON.stringify({ type: 'exit' })); session.ws.close(); }
			_edgeExecSessions.delete(msg.execId);
		}
	} else if (msg.type === 'container_event') {
		const envId = _wsToEnvId.get(ws);
		if (envId && msg.event) {
			// Call the global handler registered by hawser.ts
			if (globalThis.__hawserHandleContainerEvent) {
				globalThis.__hawserHandleContainerEvent(envId, msg.event).catch((err) => {
					console.error('[Hawser] Error handling container event:', err);
				});
			}
		}
	} else if (msg.type === 'metrics') {
		// Metrics from agent - save to database for dashboard graphs
		const envId = _wsToEnvId.get(ws);
		if (envId && msg.metrics) {
			if (globalThis.__hawserHandleMetrics) {
				globalThis.__hawserHandleMetrics(envId, msg.metrics).catch((err) => {
					console.error('[Hawser] Error saving metrics:', err);
				});
			}
		}
	}
}

// Expose send function for hawser.ts module
globalThis.__hawserSendMessage = (envId, message) => {
	const conn = _edgeConnections.get(envId);
	if (!conn?.ws) return false;
	try { conn.ws.send(message); return true; } catch { return false; }
};

// ============ Combined WebSocket Handler ============
const combinedWebsocket = {
	async open(ws) {
		const connType = ws.data?.type;

		// Hawser Edge connection - wait for hello message
		if (connType === 'hawser') {
			console.log('[Hawser] New connection pending authentication');
			return;
		}

		// Terminal connection
		const connId = 'ws-' + (++_wsConnCounter);
		ws.data = ws.data || {};
		ws.data.connId = connId;
		const { containerId, shell, user, envId } = ws.data;
		if (!containerId) { ws.send(JSON.stringify({ type: 'error', message: 'No container ID' })); ws.close(); return; }
		const target = await _getDockerTarget(envId);
		console.log('[Terminal WS] Target:', JSON.stringify({ type: target.type, host: target.host, port: target.port, hasTls: !!target.tls, hasCa: !!target.tls?.ca, hasCert: !!target.tls?.cert, hasKey: !!target.tls?.key }));

		// Handle Hawser Edge terminal
		if (target.type === 'hawser-edge') {
			const conn = _edgeConnections.get(target.environmentId);
			if (!conn) { ws.send(JSON.stringify({ type: 'error', message: 'Edge agent not connected' })); ws.close(); return; }
			const execId = crypto.randomUUID();
			_edgeExecSessions.set(execId, { ws, execId, environmentId: target.environmentId });
			ws.data.edgeExecId = execId;
			conn.ws.send(JSON.stringify({ type: 'exec_start', execId, containerId, cmd: shell || '/bin/sh', user: user || 'root', cols: 120, rows: 30 }));
			return;
		}

		try {
			console.log('[Terminal WS] Creating exec for container:', containerId);
			const exec = await createExec(containerId, [shell || '/bin/sh'], user || 'root', target);
			console.log('[Terminal WS] Exec created:', exec?.Id);
			const execId = exec.Id;
			let dockerStream;
			let headersStripped = false;
			let isChunked = false;
			const socketHandler = {
				data(socket, data) {
					if (ws.readyState === 1) {
						let text = new TextDecoder().decode(data);
						if (!headersStripped) {
							if (text.toLowerCase().includes('transfer-encoding: chunked')) isChunked = true;
							const i = text.indexOf('\\r\\n\\r\\n');
							if (i > -1) { text = text.slice(i + 4); headersStripped = true; }
							else if (text.startsWith('HTTP/')) return;
						}
						if (isChunked && text) text = text.replace(/^[0-9a-fA-F]+\\r\\n/gm, '').replace(/\\r\\n$/g, '');
						if (text) ws.send(JSON.stringify({ type: 'output', data: text }));
					}
				},
				close() { if (ws.readyState === 1) { ws.send(JSON.stringify({ type: 'exit' })); ws.close(); } },
				error(socket, error) {
					console.error('[Terminal WS] Socket error:', error?.message || error);
					if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message: 'Connection error: ' + (error?.message || 'Unknown error') }));
				},
				connectError(socket, error) {
					console.error('[Terminal WS] Connect error:', error?.message || error);
					if (ws.readyState === 1) { ws.send(JSON.stringify({ type: 'error', message: 'Failed to connect: ' + (error?.message || 'Unknown error') })); ws.close(); }
				},
				open(socket) {
					const body = JSON.stringify({ Detach: false, Tty: true });
					const tokenHeader = (target.type === 'tcp' || target.type === 'tls') && target.hawserToken ? 'X-Hawser-Token: ' + target.hawserToken + '\\r\\n' : '';
					// Use actual host for proper routing through reverse proxies like Caddy
					const host = target.host || 'localhost';
					socket.write('POST /exec/' + execId + '/start HTTP/1.1\\r\\nHost: ' + host + '\\r\\nContent-Type: application/json\\r\\n' + tokenHeader + 'Connection: Upgrade\\r\\nUpgrade: tcp\\r\\nContent-Length: ' + body.length + '\\r\\n\\r\\n' + body);
				}
			};
			if (target.type === 'unix') {
				dockerStream = await Bun.connect({ unix: target.socket, socket: socketHandler });
			} else {
				const connectOpts = { hostname: target.host, port: target.port, socket: socketHandler };
				if (target.tls) {
					connectOpts.tls = {
						sessionTimeout: 0,
						servername: target.host,
						rejectUnauthorized: target.tls.rejectUnauthorized
					};
					if (target.tls.ca) connectOpts.tls.ca = [target.tls.ca];
					if (target.tls.cert) connectOpts.tls.cert = [target.tls.cert];
					if (target.tls.key) connectOpts.tls.key = target.tls.key;
				}
				console.log('[Terminal WS] Connecting to:', connectOpts.hostname, connectOpts.port, 'TLS:', !!connectOpts.tls);
				dockerStream = await Bun.connect(connectOpts);
				console.log('[Terminal WS] Connected!');
			}
			dockerStreams.set(connId, { stream: dockerStream, execId, target });
		} catch (e) { console.error('[Terminal WS] Error:', e); ws.send(JSON.stringify({ type: 'error', message: e.message })); ws.close(); }
	},
	async message(ws, message) {
		const connType = ws.data?.type;

		// Hawser Edge message
		if (connType === 'hawser') {
			try {
				let msgStr = typeof message === 'string' ? message : message instanceof ArrayBuffer ? new TextDecoder().decode(message) : Buffer.isBuffer(message) ? message.toString('utf-8') : new TextDecoder().decode(new Uint8Array(message));
				const msg = JSON.parse(msgStr);
				await _handleHawserMessage(ws, msg);
			} catch (e) {
				console.error('[Hawser] Error:', e.message);
				ws.send(JSON.stringify({ type: 'error', error: e.message }));
			}
			return;
		}

		// Edge exec session input
		const edgeExecId = ws.data?.edgeExecId;
		if (edgeExecId) {
			const session = _edgeExecSessions.get(edgeExecId);
			if (session) {
				const conn = _edgeConnections.get(session.environmentId);
				if (conn) {
					try {
						const msg = JSON.parse(message.toString());
						if (msg.type === 'input') conn.ws.send(JSON.stringify({ type: 'exec_input', execId: edgeExecId, data: Buffer.from(msg.data).toString('base64') }));
						else if (msg.type === 'resize') conn.ws.send(JSON.stringify({ type: 'exec_resize', execId: edgeExecId, cols: msg.cols, rows: msg.rows }));
					} catch {}
				}
			}
			return;
		}

		// Terminal message
		const connId = ws.data?.connId;
		if (!connId) return;
		const d = dockerStreams.get(connId);
		if (!d) return;
		try {
			const msg = JSON.parse(message.toString());
			if (msg.type === 'input' && d.stream) d.stream.write(msg.data);
			else if (msg.type === 'resize' && d.execId) resizeExec(d.execId, msg.cols, msg.rows, d.target);
		} catch { if (d.stream) d.stream.write(message); }
	},
	close(ws) {
		const connType = ws.data?.type;

		// Hawser Edge disconnection
		if (connType === 'hawser') {
			const envId = _wsToEnvId.get(ws);
			if (envId) {
				const conn = _edgeConnections.get(envId);
				if (conn) {
					console.log('[Hawser] Agent disconnected:', conn.agentId);
					// Clear server-side ping interval
					if (conn.pingInterval) { clearInterval(conn.pingInterval); conn.pingInterval = null; }
					for (const [, p] of conn.pendingRequests) { clearTimeout(p.timeout); p.reject(new Error('Connection closed')); }
					for (const [, p] of conn.pendingStreamRequests) { p.onEnd('Connection closed'); }
					_edgeConnections.delete(envId);
					_updateEnvStatus(envId, null);
				}
				_wsToEnvId.delete(ws);
			}
			return;
		}

		// Edge exec session close
		const edgeExecId = ws.data?.edgeExecId;
		if (edgeExecId) {
			const session = _edgeExecSessions.get(edgeExecId);
			if (session) {
				const conn = _edgeConnections.get(session.environmentId);
				if (conn) conn.ws.send(JSON.stringify({ type: 'exec_end', execId: edgeExecId, reason: 'user_closed' }));
				_edgeExecSessions.delete(edgeExecId);
			}
			return;
		}

		// Terminal close
		const connId = ws.data?.connId;
		if (!connId) return;
		const d = dockerStreams.get(connId);
		if (d?.stream) d.stream.end();
		dockerStreams.delete(connId);
	}
};
`;

	const insertPoint = content.indexOf('var path = env(');
	if (insertPoint > -1) {
		content = content.slice(0, insertPoint) + wsHandler + content.slice(insertPoint);
	}

	content = content.replace(
		'var { fetch: handlerFetch, websocket } = getHandler();',
		'var { fetch: handlerFetch, websocket: _ } = getHandler(); var websocket = combinedWebsocket;'
	);

	await Bun.write(indexPath, content);
	console.log('✓ Patched index.js');
}

console.log('Patching build...');
await patchHandler();
await patchIndex();
console.log('✓ Done');
