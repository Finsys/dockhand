// v1.0.12
import '$lib/server/dns-dispatcher.js';
import { initDatabase, hasAdminUser } from '$lib/server/db';
import { startSubprocesses, stopSubprocesses } from '$lib/server/subprocess-manager';
import { startScheduler } from '$lib/server/scheduler';
import { isAuthEnabled, validateSession } from '$lib/server/auth';
import { validateApiToken } from '$lib/server/api-tokens';
import { requestContext } from '$lib/server/request-context';
import { setServerStartTime } from '$lib/server/uptime';
import { checkLicenseExpiry, getHostname } from '$lib/server/license';
import { initCryptoFallback } from '$lib/server/crypto-fallback';
import { detectHostDataDir } from '$lib/server/host-path';
import { listContainers, removeContainer } from '$lib/server/docker';
import { migrateCredentials } from '$lib/server/encryption';
import { gzipSync } from 'node:zlib';
import { rmSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { HandleServerError, Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { startRssTracker, stopRssTracker, rssBeforeOp, rssAfterOp } from '$lib/server/rss-tracker';
import { getClientIp } from '$lib/server/client-ip';
import { BACKUPS_ENABLED } from '$lib/server/features';
// Side-effect import: installs globalThis.__authenticateWsUpgrade and
// globalThis.__canAccessEnvForUser used by the raw WS upgrade handlers in
// server.js / vite.config.ts to authenticate /api/containers/*/exec.
import '$lib/server/ws-auth';

// Content types worth compressing
const COMPRESSIBLE_TYPES = [
	'application/json',
	'text/html',
	'text/plain',
	'text/css',
	'application/javascript',
	'text/javascript',
	'application/xml',
	'text/xml',
	'image/svg+xml'
];

// Minimum response size to bother compressing (1KB)
const MIN_COMPRESS_SIZE = 1024;

function shouldCompress(request: Request, response: Response): boolean {
	const acceptEncoding = request.headers.get('accept-encoding') || '';
	if (!acceptEncoding.includes('gzip')) return false;

	if (response.headers.has('content-encoding')) return false;

	const contentType = response.headers.get('content-type') || '';
	if (contentType.includes('text/event-stream')) return false;
	if (contentType.includes('octet-stream')) return false;
	if (contentType.startsWith('image/') && !contentType.includes('svg')) return false;

	const isCompressible = COMPRESSIBLE_TYPES.some(type => contentType.includes(type));
	if (!isCompressible) return false;

	const contentLength = response.headers.get('content-length');
	if (contentLength && parseInt(contentLength) < MIN_COMPRESS_SIZE) return false;

	return true;
}

async function compressResponse(request: Request, response: Response): Promise<Response> {
	if (!shouldCompress(request, response)) return response;

	const body = await response.arrayBuffer();
	if (body.byteLength < MIN_COMPRESS_SIZE) return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers
	});

	const gzipBefore = rssBeforeOp();
	const compressed = gzipSync(new Uint8Array(body));
	rssAfterOp('gzip', gzipBefore);

	const headers = new Headers(response.headers);
	headers.set('content-encoding', 'gzip');
	headers.set('vary', 'Accept-Encoding');
	headers.delete('content-length');

	return new Response(compressed, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}

// Cleanup orphaned scanner version containers from previous runs
async function cleanupOrphanedScannerContainers() {
	try {
		const containers = await listContainers(true);
		const orphaned = containers.filter(c =>
			c.name?.startsWith('dockhand-grype-version-') ||
			c.name?.startsWith('dockhand-trivy-version-')
		);
		for (const c of orphaned) {
			try {
				await removeContainer(c.id, true);
			} catch { /* ignore */ }
		}
		if (orphaned.length > 0) {
			console.log(`[Startup] Cleaned up ${orphaned.length} orphaned scanner containers`);
		}
	} catch (error) {
		// Silently ignore - Docker may not be available yet or no containers to clean
	}
}

// License expiry check interval (24 hours)
const LICENSE_CHECK_INTERVAL = 86400000;

// HMR guard for license check interval
declare global {
	var __licenseCheckInterval: ReturnType<typeof setInterval> | undefined;
}

// Initialize database on server start (synchronous with SQLite)
let initialized = false;

if (!initialized) {
	try {
		// Initialize crypto fallback first (detects old kernels and logs status)
		initCryptoFallback();

		// Cleanup orphaned TLS temp directories from previous crashes
		const dataDir = process.env.DATA_DIR || './data';
		const tmpDir = join(dataDir, 'tmp');
		if (existsSync(tmpDir)) {
			try {
				const entries = readdirSync(tmpDir);
				for (const entry of entries) {
					if (entry.startsWith('tls-')) {
						const path = join(tmpDir, entry);
						try {
							rmSync(path, { recursive: true, force: true });
							console.log(`[Startup] Cleaned orphaned TLS temp dir: ${entry}`);
						} catch { /* ignore */ }
					}
				}
			} catch { /* ignore */ }
		}

		setServerStartTime(); // Track when server started
		initDatabase();

		// Migrate plain text credentials to encrypted storage.
		// This also handles key rotation if ENCRYPTION_KEY env var differs from the
		// key file. Rotation flips the in-memory key while re-encrypting rows, so
		// anything that decrypts credentials (the scheduler's backups, subprocesses)
		// must not run until this settles — gate them on this promise below.
		const credentialsReady = migrateCredentials().catch(err => {
			console.error('[Startup] Failed to migrate credentials:', err);
		});

		// Log hostname for license validation (set by entrypoint in Docker, or os.hostname() outside)
		console.log('Hostname for license validation:', getHostname());

		// Detect host data directory for path translation
		// This allows Dockhand to translate container paths to host paths for compose volume mounts
		detectHostDataDir().then(hostPath => {
			if (hostPath) {
				console.log(`[Startup] Host data directory detected: ${hostPath}`);
			} else {
				console.warn('[Startup] Could not detect host data path.');
				console.warn('[Startup] Git stacks with relative volume paths may not work correctly.');
				console.warn('[Startup] Consider setting HOST_DATA_DIR or using matching volume paths (-v /app/data:/app/data)');
			}
		}).catch(err => {
			console.error('[Startup] Failed to detect host data directory:', err);
		});
		// Cleanup orphaned scanner containers from previous runs (non-blocking).
		cleanupOrphanedScannerContainers().catch(err => {
			console.error('Failed to cleanup orphaned scanner containers:', err);
		});
		// Start background subprocesses and the scheduler only AFTER credential
		// migration/rotation has settled, so a scheduled backup can't decrypt a
		// destination password mid-rotation (new key against old-key ciphertext).
		credentialsReady.then(() => {
			startSubprocesses().catch(err => {
				console.error('Failed to start background subprocesses:', err);
			});
			startScheduler(); // Start unified scheduler for auto-updates and git syncs (async)
		});
		startRssTracker(); // Start RSS memory tracking (no-op unless MEMORY_MONITOR=true)

		// Check license expiry on startup and then daily (with HMR guard)
		checkLicenseExpiry().catch(err => {
			console.error('Failed to check license expiry:', err);
		});
		if (!globalThis.__licenseCheckInterval) {
			globalThis.__licenseCheckInterval = setInterval(() => {
				checkLicenseExpiry().catch(err => {
					console.error('Failed to check license expiry:', err);
				});
			}, LICENSE_CHECK_INTERVAL);
		}

		// Graceful shutdown handling
		const shutdown = async () => {
			console.log('[Server] Shutting down...');
			stopRssTracker();
			await stopSubprocesses();
			process.exit(0);
		};
		process.on('SIGTERM', shutdown);
		process.on('SIGINT', shutdown);

		initialized = true;
	} catch (error) {
		console.error('Failed to initialize database:', error);
	}
}

// Bearer token auth failure rate limiting (per IP, 5-minute cooldown after 10 failures)
const bearerFailCounts = new Map<string, { count: number; firstFail: number }>();
const BEARER_FAIL_WINDOW_MS = 60_000; // 1-minute sliding window
const BEARER_FAIL_MAX = 15; // max failures per window
const BEARER_COOLDOWN_MS = 5 * 60 * 1000; // 5-minute cooldown after exceeding limit
const bearerCooldowns = new Map<string, number>(); // IP → cooldown-until timestamp

// Periodic cleanup
setInterval(() => {
	const now = Date.now();
	for (const [ip, until] of bearerCooldowns) {
		if (now > until) bearerCooldowns.delete(ip);
	}
	for (const [ip, entry] of bearerFailCounts) {
		if (now - entry.firstFail > BEARER_FAIL_WINDOW_MS) bearerFailCounts.delete(ip);
	}
}, BEARER_COOLDOWN_MS).unref?.();

function recordBearerFailure(ip: string): void {
	const now = Date.now();
	const entry = bearerFailCounts.get(ip);
	if (!entry || now - entry.firstFail > BEARER_FAIL_WINDOW_MS) {
		bearerFailCounts.set(ip, { count: 1, firstFail: now });
		return;
	}
	entry.count++;
	if (entry.count >= BEARER_FAIL_MAX) {
		bearerCooldowns.set(ip, now + BEARER_COOLDOWN_MS);
		bearerFailCounts.delete(ip);
	}
}

function isBearerRateLimited(ip: string): boolean {
	const until = bearerCooldowns.get(ip);
	if (!until) return false;
	if (Date.now() > until) {
		bearerCooldowns.delete(ip);
		return false;
	}
	return true;
}

// Routes that don't require authentication
const PUBLIC_PATHS = [
	'/login',
	'/api/auth/login',
	'/api/auth/logout',
	'/api/auth/session',
	'/api/auth/settings',
	'/api/auth/providers',
	'/api/auth/oidc',
	'/api/license',
	'/api/changelog',
	'/api/dependencies',
	'/api/health',
	'/api/settings/theme'
];

// Check if path is public
function isPublicPath(pathname: string): boolean {
	// Webhook endpoints have their own auth (signature/secret verification)
	if (pathname.match(/^\/api\/git\/stacks\/\d+\/webhook$/)) return true;
	if (pathname.match(/^\/api\/git\/webhook\/\d+$/)) return true;

	return PUBLIC_PATHS.some(path => pathname === path || pathname.startsWith(path + '/'));
}

// Check if path is a static asset
function isStaticAsset(pathname: string): boolean {
	return pathname.startsWith('/_app/') ||
		pathname.startsWith('/favicon') ||
		pathname.endsWith('.webp') ||
		pathname.endsWith('.png') ||
		pathname.endsWith('.jpg') ||
		pathname.endsWith('.svg') ||
		pathname.endsWith('.ico') ||
		pathname.endsWith('.css') ||
		pathname.endsWith('.js');
}

export const handle: Handle = async ({ event, resolve }) => {
	// Skip auth for static assets
	if (isStaticAsset(event.url.pathname)) {
		return resolve(event);
	}

	// BETA GATE — REMOVE WHEN BACKUPS GOES GA (see $lib/server/features.ts).
	// When FEAT_BACKUPS_ENABLED is off, the backup page and every /api/backup/*
	// endpoint 404 as if they don't exist. Single chokepoint so no endpoint can
	// leak; delete this block to remove the gate.
	if (!BACKUPS_ENABLED) {
		const p = event.url.pathname;
		if (p === '/backups' || p.startsWith('/backups/') || p.startsWith('/api/backup/')) {
			return new Response('Not found', { status: 404 });
		}
	}

	const httpBefore = rssBeforeOp();
	try {
		// Check if auth is enabled
		const authEnabled = await isAuthEnabled();

		// If auth is disabled, allow everything
		if (!authEnabled) {
			event.locals.user = null;
			event.locals.authEnabled = false;
			const ctx = { user: null, authEnabled: false, authMethod: 'none' as const };
			return requestContext.run(ctx, async () => compressResponse(event.request, await resolve(event)));
		}

		// Auth is enabled - check session first
		let user = await validateSession(event.cookies);
		let authMethod: 'cookie' | 'bearer' | 'none' = user ? 'cookie' : 'none';

		// If no session, try Bearer token on API routes (and /metrics, which
		// Prometheus scrapes with a Bearer token when app auth is enabled).
		if (!user && (event.url.pathname.startsWith('/api/') || event.url.pathname === '/metrics')) {
			const authHeader = event.request.headers.get('authorization');
			if (authHeader && authHeader.startsWith('Bearer dh_') && authHeader.length <= 207) {
				const clientIp = getClientIp(event);

				// Rate limit failed Bearer attempts
				if (isBearerRateLimited(clientIp)) {
					return new Response(
						JSON.stringify({ error: 'Too many failed authentication attempts' }),
						{ status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '300' } }
					);
				}

				const token = authHeader.substring(7); // strip "Bearer "
				user = await validateApiToken(token);

				if (user) {
					authMethod = 'bearer';
				} else {
					recordBearerFailure(clientIp);
				}
			}
		}

		event.locals.user = user;
		event.locals.authEnabled = true;

		const ctx = { user, authEnabled: true, authMethod };

		// Public paths don't require authentication
		if (isPublicPath(event.url.pathname)) {
			return requestContext.run(ctx, async () => compressResponse(event.request, await resolve(event)));
		}

		// If not authenticated
		if (!user) {
			// Special case: allow user creation when auth is enabled but no admin exists yet
			// This enables the first admin user to be created during initial setup
			const noAdminSetupMode = !(await hasAdminUser());
			if (noAdminSetupMode && event.url.pathname === '/api/users' && event.request.method === 'POST') {
				return requestContext.run(ctx, async () => compressResponse(event.request, await resolve(event)));
			}

			// /metrics returns a plain 401 (Prometheus scrape) — never a login redirect.
			if (event.url.pathname === '/metrics') {
				return new Response('Unauthorized', {
					status: 401,
					headers: { 'WWW-Authenticate': 'Bearer' }
				});
			}

			// API routes return 401
			if (event.url.pathname.startsWith('/api/')) {
				return new Response(
					JSON.stringify({ error: 'Unauthorized', message: 'Authentication required' }),
					{
						status: 401,
						headers: { 'Content-Type': 'application/json' }
					}
				);
			}

			// UI routes redirect to login
			const redirectUrl = encodeURIComponent(event.url.pathname + event.url.search);
			redirect(307, `/login?redirect=${redirectUrl}`);
		}

		return requestContext.run(ctx, async () => compressResponse(event.request, await resolve(event)));
	} finally {
		rssAfterOp('http', httpBefore);
	}
};

export const handleError: HandleServerError = ({ error, event }) => {
	// Skip logging 404 errors - they're expected for missing routes
	const status = (error as { status?: number })?.status;
	if (status === 404) {
		return {
			message: 'Not found',
			code: 'NOT_FOUND'
		};
	}

	// Log only essential error info without code snippets
	const message = error instanceof Error ? error.message : 'Unknown error';
	console.error(`[Error] ${event.url.pathname}: ${message}`);

	return {
		message,
		code: 'INTERNAL_ERROR'
	};
};
