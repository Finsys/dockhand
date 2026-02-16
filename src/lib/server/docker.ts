/**
 * Docker Operations Module
 *
 * Uses direct Docker API calls over Unix socket or HTTP/HTTPS.
 * No external dependencies like dockerode - uses native Bun fetch.
 */

import { homedir } from 'node:os';
import { existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Environment } from './db';
import { getStackEnvVarsAsRecord } from './db';
import { isSystemContainer } from './scheduler/tasks/update-utils';

/**
 * Custom error for when an environment is not found.
 * API endpoints should catch this and return 404.
 */
export class EnvironmentNotFoundError extends Error {
	public readonly envId: number;

	constructor(envId: number) {
		super(`Environment ${envId} not found`);
		this.name = 'EnvironmentNotFoundError';
		this.envId = envId;
	}
}

/**
 * Custom error for Docker connection failures with user-friendly messages.
 * Wraps raw Bun fetch errors to hide technical details from users.
 */
export class DockerConnectionError extends Error {
	public readonly originalError: unknown;

	constructor(message: string, originalError: unknown) {
		super(message);
		this.name = 'DockerConnectionError';
		this.originalError = originalError;
	}

	/**
	 * Create a DockerConnectionError from any error, sanitizing technical messages
	 */
	static fromError(error: unknown, context?: string): DockerConnectionError {
		const errorStr = String(error);
		let friendlyMessage: string;

		if (errorStr.includes('FailedToOpenSocket') || errorStr.includes('ECONNREFUSED')) {
			friendlyMessage = 'Docker socket not accessible';
		} else if (errorStr.includes('ECONNRESET') || errorStr.includes('connection was closed')) {
			friendlyMessage = 'Connection lost';
		} else if (errorStr.includes('verbose') || errorStr.includes('typo')) {
			friendlyMessage = 'Connection failed';
		} else if (errorStr.includes('timeout') || errorStr.includes('Timeout') || errorStr.includes('ETIMEDOUT')) {
			friendlyMessage = 'Connection timeout';
		} else if (errorStr.includes('ENOTFOUND') || errorStr.includes('getaddrinfo')) {
			friendlyMessage = 'Host not found';
		} else if (errorStr.includes('EHOSTUNREACH')) {
			friendlyMessage = 'Host unreachable';
		} else {
			friendlyMessage = 'Connection error';
		}

		if (context) {
			friendlyMessage = `${context}: ${friendlyMessage}`;
		}

		return new DockerConnectionError(friendlyMessage, error);
	}
}

/**
 * Container inspect result from Docker API
 */
export interface ContainerInspectResult {
	Id: string;
	Name: string;
	RestartCount: number;
	State: {
		Status: string;
		Running: boolean;
		Paused: boolean;
		Restarting: boolean;
		OOMKilled: boolean;
		Dead: boolean;
		Pid: number;
		ExitCode: number;
		Error: string;
		StartedAt: string;
		FinishedAt: string;
		Health?: {
			Status: string;
			FailingStreak: number;
			Log: Array<{
				Start: string;
				End: string;
				ExitCode: number;
				Output: string;
			}>;
		};
	};
	Config: {
		Hostname: string;
		User: string;
		Tty: boolean;
		Env: string[];
		Cmd: string[];
		Image: string;
		Labels: Record<string, string>;
		WorkingDir: string;
		Entrypoint: string[] | null;
	};
	NetworkSettings: {
		Networks: Record<string, {
			IPAddress: string;
			Gateway: string;
			MacAddress: string;
		}>;
		Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
	};
	Mounts: Array<{
		Type: string;
		Source: string;
		Destination: string;
		Mode: string;
		RW: boolean;
	}>;
	HostConfig: {
		Binds: string[] | null;
		NetworkMode: string;
		PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> | null;
		RestartPolicy: {
			Name: string;
			MaximumRetryCount: number;
		};
		Privileged: boolean;
		Memory: number;
		MemorySwap: number;
		NanoCpus: number;
		CpuShares: number;
	};
}

// Detect Docker socket path for local connections
function detectDockerSocket(): string {
	// Check environment variable first
	if (process.env.DOCKER_SOCKET && existsSync(process.env.DOCKER_SOCKET)) {
		console.log(`Using Docker socket from DOCKER_SOCKET env: ${process.env.DOCKER_SOCKET}`);
		return process.env.DOCKER_SOCKET;
	}

	// Check DOCKER_HOST environment variable
	if (process.env.DOCKER_HOST) {
		const dockerHost = process.env.DOCKER_HOST;
		if (dockerHost.startsWith('unix://')) {
			const socketPath = dockerHost.replace('unix://', '');
			if (existsSync(socketPath)) {
				console.log(`Using Docker socket from DOCKER_HOST: ${socketPath}`);
				return socketPath;
			}
		}
	}

	// List of possible socket locations in order of preference
	const possibleSockets = [
		'/var/run/docker.sock', // Standard Linux/Docker Desktop
		`${homedir()}/.docker/run/docker.sock`, // Docker Desktop for Mac (new location)
		`${homedir()}/.orbstack/run/docker.sock`, // OrbStack
		'/run/docker.sock', // Alternative Linux location
	];

	for (const socket of possibleSockets) {
		if (existsSync(socket)) {
			console.log(`Detected Docker socket at: ${socket}`);
			return socket;
		}
	}

	// Fallback to default
	console.warn('No Docker socket found, using default /var/run/docker.sock');
	return '/var/run/docker.sock';
}

const socketPath = detectDockerSocket();

/**
 * Demultiplex Docker stream output (strip 8-byte headers)
 * Docker streams have: 1 byte type, 3 bytes padding, 4 bytes size BE, then payload
 */
function demuxDockerStream(buffer: Buffer, options?: { separateStreams?: boolean }): string | { stdout: string; stderr: string } {
	const stdout: string[] = [];
	const stderr: string[] = [];
	let offset = 0;

	while (offset < buffer.length) {
		if (offset + 8 > buffer.length) break;

		const streamType = buffer.readUInt8(offset);
		const frameSize = buffer.readUInt32BE(offset + 4);

		if (frameSize === 0 || frameSize > buffer.length - offset - 8) {
			// Invalid frame, return raw content with control chars stripped
			const raw = buffer.toString('utf-8').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
			return options?.separateStreams ? { stdout: raw, stderr: '' } : raw;
		}

		const payload = buffer.slice(offset + 8, offset + 8 + frameSize).toString('utf-8');

		if (streamType === 1) {
			stdout.push(payload);
		} else if (streamType === 2) {
			stderr.push(payload);
		} else {
			stdout.push(payload); // Default to stdout for unknown types
		}

		offset += 8 + frameSize;
	}

	if (options?.separateStreams) {
		return { stdout: stdout.join(''), stderr: stderr.join('') };
	}
	return [...stdout, ...stderr].join('');
}

/**
 * Process Docker stream frames incrementally from a buffer
 * Returns processed frames and remaining buffer
 */
function processStreamFrames(
	buffer: Buffer,
	onStdout?: (data: string) => void,
	onStderr?: (data: string) => void
): { stdout: string; remaining: Buffer<ArrayBufferLike> } {
	// Collect stdout frame payloads as raw buffers first, then decode to UTF-8 once
	// at the end. Decoding each frame individually corrupts multi-byte UTF-8 characters
	// that may be split across frame boundaries (observed with Grype on Synology NAS).
	const stdoutChunks: Buffer[] = [];
	let stdoutLen = 0;
	let offset = 0;

	while (buffer.length >= offset + 8) {
		const streamType = buffer.readUInt8(offset);
		const frameSize = buffer.readUInt32BE(offset + 4);

		// Validate stream type (0=stdin, 1=stdout, 2=stderr)
		if (streamType > 2) break;

		// Sanity check - no single frame should be > 10MB
		if (frameSize > 10 * 1024 * 1024) break;

		if (buffer.length < offset + 8 + frameSize) break;

		const payloadBuf = buffer.slice(offset + 8, offset + 8 + frameSize);

		if (streamType === 1) {
			stdoutChunks.push(payloadBuf);
			stdoutLen += payloadBuf.length;
			onStdout?.(payloadBuf.toString('utf-8'));
		} else if (streamType === 2) {
			onStderr?.(payloadBuf.toString('utf-8'));
		}

		offset += 8 + frameSize;
	}

	const stdout = Buffer.concat(stdoutChunks, stdoutLen).toString('utf-8');
	return { stdout, remaining: buffer.slice(offset) };
}

// Cache for environment configurations with timestamps
interface CachedEnv {
	env: Environment;
	lastUsed: number;
}
const envCache = new Map<number, CachedEnv>();

// Cache TTL: 30 minutes (in milliseconds)
const CACHE_TTL = 30 * 60 * 1000;

// Cleanup stale cache entries periodically
function cleanupEnvCache() {
	const now = Date.now();
	const entries = Array.from(envCache.entries());
	for (const [envId, cached] of entries) {
		if (now - cached.lastUsed > CACHE_TTL) {
			envCache.delete(envId);
		}
	}
}

// Guard against multiple intervals during HMR
declare global {
	var __dockerEnvCacheCleanupInterval: ReturnType<typeof setInterval> | undefined;
}

// Run cleanup every 10 minutes (guarded to prevent HMR leaks)
if (!globalThis.__dockerEnvCacheCleanupInterval) {
	globalThis.__dockerEnvCacheCleanupInterval = setInterval(cleanupEnvCache, 10 * 60 * 1000);
}

// Import db functions for environment lookup
import { getEnvironment } from './db';

// Import hawser edge connection manager for edge mode routing
import { sendEdgeRequest, sendEdgeStreamRequest, isEdgeConnected, type EdgeResponse } from './hawser';

/**
 * Docker API client configuration
 */
interface DockerClientConfig {
	type: 'socket' | 'http' | 'https';
	socketPath?: string;
	host?: string;
	port?: number;
	ca?: string;
	cert?: string;
	key?: string;
	skipVerify?: boolean;
	// Hawser connection settings
	connectionType?: 'socket' | 'direct' | 'hawser-standard' | 'hawser-edge';
	hawserToken?: string;
	// Environment ID for edge mode routing
	environmentId?: number;
}

/**
 * Build Docker client config from an environment
 */
function buildConfigFromEnv(env: Environment): DockerClientConfig {
	// Socket connection type - use Unix socket
	if (env.connectionType === 'socket' || !env.connectionType) {
		return {
			type: 'socket',
			socketPath: env.socketPath || '/var/run/docker.sock',
			connectionType: 'socket',
			environmentId: env.id
		};
	}

	// Direct or Hawser connection types - use HTTP/HTTPS
	const protocol = (env.protocol as 'http' | 'https') || 'http';
	return {
		type: protocol,
		host: env.host || 'localhost',
		port: env.port || 2375,
		ca: env.tlsCa || undefined,
		cert: env.tlsCert || undefined,
		key: env.tlsKey || undefined,
		skipVerify: env.tlsSkipVerify || undefined,
		connectionType: env.connectionType as 'direct' | 'hawser-standard' | 'hawser-edge',
		hawserToken: env.hawserToken || undefined,
		environmentId: env.id
	};
}

/**
 * Get Docker client configuration for an environment
 */
async function getDockerConfig(envId?: number | null): Promise<DockerClientConfig> {
	if (!envId) {
		throw new Error('No environment specified');
	}

	// Check cache first
	const cached = envCache.get(envId);
	if (cached) {
		cached.lastUsed = Date.now();
		return buildConfigFromEnv(cached.env);
	}

	// Fetch and cache
	const env = await getEnvironment(envId);
	if (env) {
		envCache.set(envId, { env, lastUsed: Date.now() });
		return buildConfigFromEnv(env);
	}

	throw new EnvironmentNotFoundError(envId);
}

interface DockerFetchOptions extends RequestInit {
	/** Set to true for long-lived streaming connections (disables Bun's idle timeout) */
	streaming?: boolean;
}

/**
 * Check if a string is valid base64
 */
function isBase64(str: string): boolean {
	if (!str || str.length === 0) return false;
	// Base64 strings have length divisible by 4 and contain only valid chars
	if (str.length % 4 !== 0) return false;
	return /^[A-Za-z0-9+/]*={0,2}$/.test(str);
}

/**
 * Convert EdgeResponse from hawser WebSocket to a standard Response object
 * Handles base64-encoded binary data from Go agent
 */
function edgeResponseToResponse(edgeResponse: EdgeResponse): Response {
	let body: string | Uint8Array = edgeResponse.body;

	// The Go agent sends isBinary flag to indicate if body is base64-encoded
	if (edgeResponse.isBinary && typeof body === 'string' && body.length > 0) {
		// Decode base64 to binary
		body = Uint8Array.from(atob(body), c => c.charCodeAt(0));
	}

	return new Response(body as BodyInit, {
		status: edgeResponse.statusCode,
		headers: edgeResponse.headers
	});
}

/**
 * Drain a response body to release the underlying socket/TLS connection.
 * Must be called on any Response whose body won't otherwise be consumed.
 */
export async function drainResponse(response: Response): Promise<void> {
	if (!response.bodyUsed) {
		try { await response.arrayBuffer(); } catch {}
	}
}

/**
 * Make a request to the Docker API
 * Exported for use by stacks.ts module
 */
export async function dockerFetch(
	path: string,
	options: DockerFetchOptions = {},
	envId?: number | null
): Promise<Response> {
	const startTime = Date.now();
	const config = await getDockerConfig(envId);
	const { streaming, ...fetchOptions } = options;
	const method = (options.method || 'GET').toUpperCase();

	// For streaming connections, disable Bun's idle timeout
	// This prevents long-lived streams (like Docker events) from being terminated
	const bunOptions = streaming ? { timeout: false } : {};

	// Hawser Edge mode - route through WebSocket connection
	if (config.connectionType === 'hawser-edge' && config.environmentId) {
		// Check if agent is connected
		if (!isEdgeConnected(config.environmentId)) {
			const error = new Error('Hawser Edge agent is not connected');
			// Log without stack trace for cleaner output
			console.warn(`[Docker] Edge env ${config.environmentId}: agent not connected for ${method} ${path}`);
			throw error;
		}

		// Extract request details
		const headers: Record<string, string> = {};

		// Convert Headers object to plain object
		if (fetchOptions.headers) {
			if (fetchOptions.headers instanceof Headers) {
				fetchOptions.headers.forEach((value, key) => {
					headers[key] = value;
				});
			} else if (typeof fetchOptions.headers === 'object') {
				Object.assign(headers, fetchOptions.headers);
			}
		}

		// Parse body if present
		let body: unknown;
		if (fetchOptions.body) {
			if (typeof fetchOptions.body === 'string') {
				try {
					body = JSON.parse(fetchOptions.body);
				} catch {
					body = fetchOptions.body;
				}
			} else {
				body = fetchOptions.body;
			}
		}

		// Send request through edge connection
		try {
			const edgeResponse = await sendEdgeRequest(
				config.environmentId,
				method,
				path,
				body,
				headers,
				streaming || false,
				(streaming || path === '/_hawser/compose') ? 300000 : 30000 // 5 min for streaming/compose, 30s for normal
			);
			const elapsed = Date.now() - startTime;
			// Only warn for slow requests, but skip /stats which is expected to be slow (5-10s)
			if (elapsed > 5000 && !path.includes('/stats')) {
				console.warn(`[Docker] Edge env ${config.environmentId}: ${method} ${path} took ${elapsed}ms`);
			}
			return edgeResponseToResponse(edgeResponse);
		} catch (error: any) {
			const elapsed = Date.now() - startTime;
			// Log error message only, not full stack trace
			const msg = error?.message || String(error);
			console.error(`[Docker] Edge env ${config.environmentId}: ${method} ${path} failed after ${elapsed}ms: ${msg}`);
			throw DockerConnectionError.fromError(error);
		}
	}

	if (config.type === 'socket') {
		// Use Bun's native Unix socket support
		const url = `http://localhost${path}`;
		try {
			const response = await fetch(url, {
				...fetchOptions,
				// @ts-ignore - Bun supports unix socket and timeout options
				unix: config.socketPath,
				...bunOptions
			});
			const elapsed = Date.now() - startTime;
			// Only warn for slow requests, but skip /stats which is expected to be slow (5-10s)
			if (elapsed > 5000 && !path.includes('/stats')) {
				console.warn(`[Docker] Socket: ${method} ${path} took ${elapsed}ms`);
			}
			return response;
		} catch (error: any) {
			const elapsed = Date.now() - startTime;
			// Log error message only, not full stack trace
			const msg = error?.message || String(error);
			console.error(`[Docker] Socket: ${method} ${path} failed after ${elapsed}ms: ${msg}`);
			throw DockerConnectionError.fromError(error);
		}
	} else {
		// HTTP/HTTPS remote connection
		const protocol = config.type;
		const url = `${protocol}://${config.host}:${config.port}${path}`;

		const finalOptions: RequestInit = { ...fetchOptions };

		// For Hawser Standard mode with token authentication
		if (config.connectionType === 'hawser-standard' && config.hawserToken) {
			finalOptions.headers = {
				...finalOptions.headers,
				'X-Hawser-Token': config.hawserToken
			};
		}

		// For HTTPS with TLS certificates, we need to configure TLS
		// Pass certificate strings directly to Bun's fetch - no temp files needed
		if (config.type === 'https') {
			const tlsOptions: Record<string, unknown> = {};

			// Detect if mutual TLS (client certificate authentication) is in use
			const isMtls = !!(config.cert && config.key);

			if (isMtls) {
				// mTLS: Disable session caching to prevent Bun from reusing a TLS session
				// with wrong client certificates (pool key doesn't include certs)
				tlsOptions.sessionTimeout = 0;
			} else {
				// Non-mTLS HTTPS (CA-only or skip-verify): Allow short-lived session reuse.
				// Without this, every fetch allocates a new native TLS context in BoringSSL.
				// Native memory (mmap) is never returned to the OS, causing RSS to grow
				// continuously in long-running subprocesses (metrics, events).
				// 30s allows sessions to be reused within one metrics cycle, then expire.
				tlsOptions.sessionTimeout = 30;
			}

			// Set explicit servername for SNI - isolates TLS contexts per host
			tlsOptions.servername = config.host;

			// Load CA certificate (just this environment's CA, not composite)
			if (config.ca) {
				tlsOptions.ca = [config.ca];
			}

			// Client cert and key for mTLS authentication
			if (config.cert) {
				tlsOptions.cert = [config.cert];
			}
			if (config.key) {
				tlsOptions.key = config.key;
			}

			// Skip verification (self-signed without CA)
			if (config.skipVerify) {
				tlsOptions.rejectUnauthorized = false;
			} else {
				tlsOptions.rejectUnauthorized = true;
			}

			if (Object.keys(tlsOptions).length > 0) {
				// @ts-ignore - Bun supports tls options with string certs
				finalOptions.tls = tlsOptions;
				if (isMtls) {
					// mTLS: Force new connection for each request to prevent Bun from
					// reusing a TLS session with wrong client certificates
					// @ts-ignore - Bun supports keepalive option
					finalOptions.keepalive = false;
				}
				// Non-mTLS: Use Bun's default keepalive (connection reuse) to avoid
				// allocating a new native TLS context per request
			}

				// Optional verbose TLS debugging
			if (process.env.DEBUG_TLS) {
				// @ts-ignore - Bun-specific verbose option
				finalOptions.verbose = true;
			}
		}

		// Add default timeout for non-streaming requests to prevent socket accumulation
		// Compose operations need more time (up to 5 minutes) for multi-service stacks
		if (!streaming && !finalOptions.signal) {
			const isComposeOperation = path === '/_hawser/compose';
			finalOptions.signal = AbortSignal.timeout(isComposeOperation ? 300000 : 30000);
		}

		try {
			const response = await fetch(url, { ...finalOptions, ...bunOptions });
			const elapsed = Date.now() - startTime;
			// Only warn for slow requests, but skip /stats which is expected to be slow (5-10s)
			if (elapsed > 5000 && !path.includes('/stats')) {
				console.warn(`[Docker] ${config.connectionType || 'direct'} ${config.host}: ${method} ${path} took ${elapsed}ms`);
			}
			return response;
		} catch (error: any) {
			const elapsed = Date.now() - startTime;
			// Log error message only, not full stack trace
			const msg = error?.message || String(error);
			console.error(`[Docker] ${config.connectionType || 'direct'} ${config.host}: ${method} ${path} failed after ${elapsed}ms: ${msg}`);
			throw DockerConnectionError.fromError(error);
		}
	}
}

/**
 * Make a JSON request to Docker API
 */
async function dockerJsonRequest<T>(
	path: string,
	options: RequestInit = {},
	envId?: number | null
): Promise<T> {
	const response = await dockerFetch(path, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			...options.headers
		}
	}, envId);

	if (!response.ok) {
		const errorText = await response.text();
		let errorJson: any = {};
		try {
			errorJson = JSON.parse(errorText);
		} catch {
			// Not JSON, use text as message
			errorJson = { message: errorText };
		}
		const error: any = new Error(errorJson.message || `Docker API error: ${response.status}`);
		error.statusCode = response.status;
		error.json = errorJson;
		throw error;
	}

	return response.json();
}

// Clear cached client for an environment (e.g., when settings change)
export function clearDockerClientCache(envId?: number) {
	if (envId !== undefined) {
		envCache.delete(envId);
	} else {
		envCache.clear();
	}
}

export interface ContainerInfo {
	id: string;
	name: string;
	image: string;
	state: string;
	status: string;
	created: number;
	ports: Array<{
		IP?: string;
		PrivatePort: number;
		PublicPort?: number;
		Type: string;
	}>;
	networks: { [networkName: string]: { ipAddress: string } };
	health?: string;
	restartCount: number;
	mounts: Array<{ type: string; source: string; destination: string; mode: string; rw: boolean }>;
	labels: { [key: string]: string };
	command: string;
}

export interface ImageInfo {
	id: string;
	tags: string[];
	size: number;
	created: number;
}

// Container operations
export async function listContainers(all = true, envId?: number | null): Promise<ContainerInfo[]> {
	const containers = await dockerJsonRequest<any[]>(
		`/containers/json?all=${all}`,
		{},
		envId
	);

	// Fetch restart counts only for restarting containers
	const restartCounts = new Map<string, number>();
	const restartingContainers = containers.filter(c => c.State === 'restarting');

	await Promise.all(
		restartingContainers.map(async (container) => {
			try {
				const inspect = await inspectContainer(container.Id, envId);
				restartCounts.set(container.Id, inspect.RestartCount || 0);
			} catch {
				// Ignore errors
			}
		})
	);

	return containers.map((container) => {
		// Extract network info with IP addresses
		const networks: { [networkName: string]: { ipAddress: string } } = {};
		if (container.NetworkSettings?.Networks) {
			for (const [networkName, networkData] of Object.entries(container.NetworkSettings.Networks)) {
				networks[networkName] = {
					ipAddress: (networkData as any).IPAddress || ''
				};
			}
		}

		// Extract mount info
		const mounts = (container.Mounts || []).map((m: any) => ({
			type: m.Type || 'unknown',
			source: m.Source || m.Name || '',
			destination: m.Destination || '',
			mode: m.Mode || '',
			rw: m.RW ?? true
		}));

		// Extract health status from Status string
		// Docker formats: "(healthy)", "(unhealthy)", "(health: starting)"
		let health: string | undefined;
		const healthMatch = container.Status?.match(/\((healthy|unhealthy|health:\s*starting)\)/i);
		if (healthMatch) {
			const matched = healthMatch[1].toLowerCase();
			// Normalize "health: starting" to just "starting"
			health = matched.includes('starting') ? 'starting' : matched;
		}

		return {
			id: container.Id,
			name: container.Names[0]?.replace(/^\//, '') || 'unnamed',
			image: container.Image,
			state: container.State,
			status: container.Status,
			created: container.Created,
			ports: container.Ports || [],
			networks,
			health,
			restartCount: restartCounts.get(container.Id) || 0,
			mounts,
			labels: container.Labels || {},
			command: container.Command || '',
			systemContainer: isSystemContainer(container.Image || '')
		};
	});
}

export async function getContainerStats(id: string, envId?: number | null) {
	return dockerJsonRequest(`/containers/${id}/stats?stream=false`, {}, envId);
}

export async function startContainer(id: string, envId?: number | null) {
	const response = await dockerFetch(`/containers/${id}/start`, { method: 'POST' }, envId);
	await drainResponse(response);
}

export async function stopContainer(id: string, envId?: number | null) {
	const response = await dockerFetch(`/containers/${id}/stop`, { method: 'POST' }, envId);
	await drainResponse(response);
}

export async function restartContainer(id: string, envId?: number | null) {
	const response = await dockerFetch(`/containers/${id}/restart`, { method: 'POST' }, envId);
	await drainResponse(response);
}

export async function pauseContainer(id: string, envId?: number | null) {
	const response = await dockerFetch(`/containers/${id}/pause`, { method: 'POST' }, envId);
	await drainResponse(response);
}

export async function unpauseContainer(id: string, envId?: number | null) {
	const response = await dockerFetch(`/containers/${id}/unpause`, { method: 'POST' }, envId);
	await drainResponse(response);
}

export async function removeContainer(id: string, force = false, envId?: number | null) {
	const response = await dockerFetch(`/containers/${id}?force=${force}`, { method: 'DELETE' }, envId);
	if (!response.ok && response.status !== 404) {
		const errorBody = await response.text();
		let errorMessage = `Failed to remove container ${id}`;
		try {
			const parsed = JSON.parse(errorBody);
			if (parsed.message) {
				errorMessage = parsed.message;
			}
		} catch {
			if (errorBody) {
				errorMessage = errorBody;
			}
		}
		throw new Error(errorMessage);
	}
}

export async function renameContainer(id: string, newName: string, envId?: number | null) {
	const response = await dockerFetch(`/containers/${id}/rename?name=${encodeURIComponent(newName)}`, { method: 'POST' }, envId);
	await drainResponse(response);
}

export async function getContainerLogs(id: string, tail = 100, envId?: number | null): Promise<string> {
	// Check if container has TTY enabled
	const info = await inspectContainer(id, envId);
	const hasTty = info.Config?.Tty ?? false;

	const response = await dockerFetch(
		`/containers/${id}/logs?stdout=true&stderr=true&tail=${tail}&timestamps=true`,
		{},
		envId
	);

	const buffer = Buffer.from(await response.arrayBuffer());

	// If TTY is enabled, logs are raw text (no demux needed)
	if (hasTty) {
		return buffer.toString('utf-8');
	}

	return demuxDockerStream(buffer) as string;
}

export async function inspectContainer(id: string, envId?: number | null): Promise<ContainerInspectResult> {
	return dockerJsonRequest<ContainerInspectResult>(`/containers/${id}/json`, {}, envId);
}

export interface HealthcheckConfig {
	test?: string[];
	interval?: number;
	timeout?: number;
	retries?: number;
	startPeriod?: number;
}

export interface UlimitConfig {
	name: string;
	soft: number;
	hard: number;
}

export interface DeviceMapping {
	hostPath: string;
	containerPath: string;
	permissions?: string;
}

/** GPU/device request for containers (e.g., Nvidia GPU) */
export interface DeviceRequest {
	driver?: string;
	count?: number;
	deviceIDs?: string[];
	capabilities?: string[][];
	options?: { [key: string]: string };
}

export interface CreateContainerOptions {
	name: string;
	image: string;
	ports?: { [key: string]: { HostIp?: string; HostPort: string } };
	volumes?: { [key: string]: {} };
	volumeBinds?: string[];
	env?: string[];
	labels?: { [key: string]: string };
	cmd?: string[];
	entrypoint?: string[];
	workingDir?: string;
	restartPolicy?: string;
	restartMaxRetries?: number;
	networkMode?: string;
	networks?: string[];
	/** Network aliases for the primary network */
	networkAliases?: string[];
	/** Static IPv4 address for the primary network */
	networkIpv4Address?: string;
	/** Static IPv6 address for the primary network */
	networkIpv6Address?: string;
	/** Gateway priority for the primary network (Docker Engine 28+) */
	networkGwPriority?: number;
	user?: string;
	privileged?: boolean;
	healthcheck?: HealthcheckConfig;
	memory?: number;
	memoryReservation?: number;
	memorySwap?: number;
	cpuShares?: number;
	cpuQuota?: number;
	cpuPeriod?: number;
	nanoCpus?: number;
	capAdd?: string[];
	capDrop?: string[];
	devices?: DeviceMapping[];
	dns?: string[];
	dnsSearch?: string[];
	dnsOptions?: string[];
	securityOpt?: string[];
	ulimits?: UlimitConfig[];
	// Terminal settings
	tty?: boolean;
	stdinOpen?: boolean;
	// Process and memory settings
	oomKillDisable?: boolean;
	pidsLimit?: number;
	shmSize?: number;
	// Tmpfs mounts
	tmpfs?: { [key: string]: string };
	// Sysctls
	sysctls?: { [key: string]: string };
	// Logging configuration
	logDriver?: string;
	logOptions?: { [key: string]: string };
	// Namespace settings
	ipcMode?: string;
	pidMode?: string;
	utsMode?: string;
	// Hostname
	hostname?: string;
	// Cgroup parent
	cgroupParent?: string;
	// Stop signal
	stopSignal?: string;
	// Init process
	init?: boolean;
	// Stop timeout
	stopTimeout?: number;
	// MAC address
	macAddress?: string;
	// Extra hosts (/etc/hosts entries)
	extraHosts?: string[];
	// Device requests (GPU access, etc.)
	deviceRequests?: DeviceRequest[];
	// Container runtime (e.g., 'runc', 'nvidia' for GPU containers)
	runtime?: string;
	// Read-only root filesystem
	readonlyRootfs?: boolean;
	// CPU pinning (e.g., "0-3", "0,1")
	cpusetCpus?: string;
	// NUMA memory nodes (e.g., "0-1", "0")
	cpusetMems?: string;
	// Additional groups for the container process
	groupAdd?: string[];
	// Memory swappiness (0-100)
	memorySwappiness?: number;
	// User namespace mode
	usernsMode?: string;
	// Domain name
	domainname?: string;
}

export async function createContainer(options: CreateContainerOptions, envId?: number | null) {
	const containerConfig: any = {
		Image: options.image,
		Env: options.env || [],
		Labels: options.labels || {},
		HostConfig: {
			RestartPolicy: {
				Name: options.restartPolicy || 'no',
				...(options.restartPolicy === 'on-failure' && options.restartMaxRetries !== undefined
					? { MaximumRetryCount: options.restartMaxRetries }
					: {})
			}
		}
	};

	if (options.cmd && options.cmd.length > 0) {
		containerConfig.Cmd = options.cmd;
	}

	if (options.user) {
		containerConfig.User = options.user;
	}

	if (options.healthcheck) {
		containerConfig.Healthcheck = {};
		if (options.healthcheck.test && options.healthcheck.test.length > 0) {
			containerConfig.Healthcheck.Test = options.healthcheck.test;
		}
		if (options.healthcheck.interval !== undefined) {
			containerConfig.Healthcheck.Interval = options.healthcheck.interval;
		}
		if (options.healthcheck.timeout !== undefined) {
			containerConfig.Healthcheck.Timeout = options.healthcheck.timeout;
		}
		if (options.healthcheck.retries !== undefined) {
			containerConfig.Healthcheck.Retries = options.healthcheck.retries;
		}
		if (options.healthcheck.startPeriod !== undefined) {
			containerConfig.Healthcheck.StartPeriod = options.healthcheck.startPeriod;
		}
	}

	if (options.ports) {
		containerConfig.ExposedPorts = {};
		containerConfig.HostConfig.PortBindings = {};

		for (const [containerPort, hostConfig] of Object.entries(options.ports)) {
			containerConfig.ExposedPorts[containerPort] = {};
			containerConfig.HostConfig.PortBindings[containerPort] = [hostConfig];
		}
	}

	if (options.volumeBinds && options.volumeBinds.length > 0) {
		containerConfig.HostConfig.Binds = options.volumeBinds;
	}

	if (options.volumes) {
		containerConfig.Volumes = options.volumes;
	}

	if (options.networkMode) {
		containerConfig.HostConfig.NetworkMode = options.networkMode;

		// Build endpoint config for primary network with aliases, static IP, and gateway priority
		const hasNetworkConfig = options.networkAliases?.length || options.networkIpv4Address || options.networkIpv6Address || options.networkGwPriority !== undefined;
		if (hasNetworkConfig) {
			const endpointConfig: any = {};

			if (options.networkAliases && options.networkAliases.length > 0) {
				endpointConfig.Aliases = options.networkAliases;
			}

			if (options.networkIpv4Address || options.networkIpv6Address) {
				endpointConfig.IPAMConfig = {};
				if (options.networkIpv4Address) {
					endpointConfig.IPAMConfig.IPv4Address = options.networkIpv4Address;
				}
				if (options.networkIpv6Address) {
					endpointConfig.IPAMConfig.IPv6Address = options.networkIpv6Address;
				}
			}

			// Gateway priority (Docker Engine 28+)
			if (options.networkGwPriority !== undefined) {
				endpointConfig.GwPriority = options.networkGwPriority;
			}

			containerConfig.NetworkingConfig = {
				EndpointsConfig: {
					[options.networkMode]: endpointConfig
				}
			};
		}
	}

	if (options.networks && options.networks.length > 0) {
		containerConfig.HostConfig.NetworkMode = options.networks[0];

		// Build endpoint configs for all networks
		const endpointsConfig: Record<string, any> = {};

		for (const network of options.networks) {
			const isFirstNetwork = network === options.networks[0];
			const endpointConfig: any = {};

			// Apply aliases, static IP, and gateway priority only to the first (primary) network
			if (isFirstNetwork) {
				if (options.networkAliases && options.networkAliases.length > 0) {
					endpointConfig.Aliases = options.networkAliases;
				}
				if (options.networkIpv4Address || options.networkIpv6Address) {
					endpointConfig.IPAMConfig = {};
					if (options.networkIpv4Address) {
						endpointConfig.IPAMConfig.IPv4Address = options.networkIpv4Address;
					}
					if (options.networkIpv6Address) {
						endpointConfig.IPAMConfig.IPv6Address = options.networkIpv6Address;
					}
				}
				// Gateway priority (Docker Engine 28+)
				if (options.networkGwPriority !== undefined) {
					endpointConfig.GwPriority = options.networkGwPriority;
				}
			}

			endpointsConfig[network] = endpointConfig;
		}

		containerConfig.NetworkingConfig = {
			EndpointsConfig: endpointsConfig
		};
	}

	if (options.privileged) {
		containerConfig.HostConfig.Privileged = options.privileged;
	}

	if (options.memory) {
		containerConfig.HostConfig.Memory = options.memory;
	}
	if (options.memoryReservation) {
		containerConfig.HostConfig.MemoryReservation = options.memoryReservation;
	}
	if (options.cpuShares) {
		containerConfig.HostConfig.CpuShares = options.cpuShares;
	}
	if (options.cpuQuota) {
		containerConfig.HostConfig.CpuQuota = options.cpuQuota;
	}
	if (options.cpuPeriod) {
		containerConfig.HostConfig.CpuPeriod = options.cpuPeriod;
	}
	if (options.nanoCpus) {
		containerConfig.HostConfig.NanoCpus = options.nanoCpus;
	}

	if (options.capAdd && options.capAdd.length > 0) {
		containerConfig.HostConfig.CapAdd = options.capAdd;
	}
	if (options.capDrop && options.capDrop.length > 0) {
		containerConfig.HostConfig.CapDrop = options.capDrop;
	}

	if (options.devices && options.devices.length > 0) {
		containerConfig.HostConfig.Devices = options.devices.map(d => ({
			PathOnHost: d.hostPath,
			PathInContainer: d.containerPath,
			CgroupPermissions: d.permissions || 'rwm'
		}));
	}

	if (options.dns && options.dns.length > 0) {
		containerConfig.HostConfig.Dns = options.dns;
	}
	if (options.dnsSearch && options.dnsSearch.length > 0) {
		containerConfig.HostConfig.DnsSearch = options.dnsSearch;
	}
	if (options.dnsOptions && options.dnsOptions.length > 0) {
		containerConfig.HostConfig.DnsOptions = options.dnsOptions;
	}

	if (options.securityOpt && options.securityOpt.length > 0) {
		containerConfig.HostConfig.SecurityOpt = options.securityOpt;
	}

	if (options.ulimits && options.ulimits.length > 0) {
		containerConfig.HostConfig.Ulimits = options.ulimits.map(u => ({
			Name: u.name,
			Soft: u.soft,
			Hard: u.hard
		}));
	}

	// Entrypoint
	if (options.entrypoint && options.entrypoint.length > 0) {
		containerConfig.Entrypoint = options.entrypoint;
	}

	// Working directory
	if (options.workingDir) {
		containerConfig.WorkingDir = options.workingDir;
	}

	// Hostname
	if (options.hostname) {
		containerConfig.Hostname = options.hostname;
	}

	// TTY and StdinOpen
	if (options.tty !== undefined) {
		containerConfig.Tty = options.tty;
	}
	if (options.stdinOpen !== undefined) {
		containerConfig.OpenStdin = options.stdinOpen;
	}

	// Memory swap
	if (options.memorySwap !== undefined) {
		containerConfig.HostConfig.MemorySwap = options.memorySwap;
	}

	// OOM kill disable
	if (options.oomKillDisable !== undefined) {
		containerConfig.HostConfig.OomKillDisable = options.oomKillDisable;
	}

	// Pids limit
	if (options.pidsLimit !== undefined) {
		containerConfig.HostConfig.PidsLimit = options.pidsLimit;
	}

	// Shared memory size
	if (options.shmSize !== undefined) {
		containerConfig.HostConfig.ShmSize = options.shmSize;
	}

	// Tmpfs mounts
	if (options.tmpfs && Object.keys(options.tmpfs).length > 0) {
		containerConfig.HostConfig.Tmpfs = options.tmpfs;
	}

	// Sysctls
	if (options.sysctls && Object.keys(options.sysctls).length > 0) {
		containerConfig.HostConfig.Sysctls = options.sysctls;
	}

	// Logging configuration
	if (options.logDriver) {
		containerConfig.HostConfig.LogConfig = {
			Type: options.logDriver,
			Config: options.logOptions || {}
		};
	}

	// IPC mode
	if (options.ipcMode) {
		containerConfig.HostConfig.IpcMode = options.ipcMode;
	}

	// PID mode
	if (options.pidMode) {
		containerConfig.HostConfig.PidMode = options.pidMode;
	}

	// UTS mode
	if (options.utsMode) {
		containerConfig.HostConfig.UTSMode = options.utsMode;
	}

	// Cgroup parent
	if (options.cgroupParent) {
		containerConfig.HostConfig.CgroupParent = options.cgroupParent;
	}

	// Stop signal
	if (options.stopSignal) {
		containerConfig.StopSignal = options.stopSignal;
	}

	// Init process
	if (options.init !== undefined) {
		containerConfig.HostConfig.Init = options.init;
	}

	// Stop timeout
	if (options.stopTimeout !== undefined) {
		containerConfig.StopTimeout = options.stopTimeout;
	}

	// MAC address
	if (options.macAddress) {
		containerConfig.MacAddress = options.macAddress;
	}

	// Extra hosts (/etc/hosts entries)
	if (options.extraHosts && options.extraHosts.length > 0) {
		containerConfig.HostConfig.ExtraHosts = options.extraHosts;
	}

	// Device requests (GPU access, etc.)
	if (options.deviceRequests && options.deviceRequests.length > 0) {
		containerConfig.HostConfig.DeviceRequests = options.deviceRequests.map(dr => ({
			Driver: dr.driver || '',
			Count: dr.count ?? -1,
			DeviceIDs: dr.deviceIDs || [],
			Capabilities: dr.capabilities || [],
			Options: dr.options || {}
		}));
	}

	// Container runtime (e.g., 'nvidia' for GPU containers)
	if (options.runtime) {
		containerConfig.HostConfig.Runtime = options.runtime;
	}

	// Read-only root filesystem
	if (options.readonlyRootfs !== undefined) {
		containerConfig.HostConfig.ReadonlyRootfs = options.readonlyRootfs;
	}

	// CPU pinning
	if (options.cpusetCpus) {
		containerConfig.HostConfig.CpusetCpus = options.cpusetCpus;
	}

	// NUMA memory nodes
	if (options.cpusetMems) {
		containerConfig.HostConfig.CpusetMems = options.cpusetMems;
	}

	// Additional groups
	if (options.groupAdd && options.groupAdd.length > 0) {
		containerConfig.HostConfig.GroupAdd = options.groupAdd;
	}

	// Memory swappiness
	if (options.memorySwappiness !== undefined) {
		containerConfig.HostConfig.MemorySwappiness = options.memorySwappiness;
	}

	// User namespace mode
	if (options.usernsMode) {
		containerConfig.HostConfig.UsernsMode = options.usernsMode;
	}

	// Domain name
	if (options.domainname) {
		containerConfig.Domainname = options.domainname;
	}

	const result = await dockerJsonRequest<{ Id: string }>(
		`/containers/create?name=${encodeURIComponent(options.name)}`,
		{
			method: 'POST',
			body: JSON.stringify(containerConfig)
		},
		envId
	);

	return { id: result.Id, start: () => startContainer(result.Id, envId) };
}

/**
 * Deep-diff two objects recursively, returning all paths that differ.
 */
export function deepDiff(a: any, b: any, path = ''): string[] {
	const diffs: string[] = [];

	if (a === b) return diffs;
	if (a === null || b === null || typeof a !== typeof b) {
		diffs.push(`${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
		return diffs;
	}
	if (typeof a !== 'object') {
		if (a !== b) diffs.push(`${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
		return diffs;
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		const aStr = JSON.stringify(a);
		const bStr = JSON.stringify(b);
		if (aStr !== bStr) diffs.push(`${path}: ${aStr} → ${bStr}`);
		return diffs;
	}

	const allKeys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]));
	for (const key of allKeys) {
		const childPath = path ? `${path}.${key}` : key;
		if (!(key in a)) {
			diffs.push(`${childPath}: <missing> → ${JSON.stringify(b[key])}`);
		} else if (!(key in b)) {
			diffs.push(`${childPath}: ${JSON.stringify(a[key])} → <missing>`);
		} else {
			diffs.push(...deepDiff(a[key], b[key], childPath));
		}
	}

	return diffs;
}

/**
 * Recreate a container using full Config/HostConfig passthrough from inspect data.
 * Passes Config and HostConfig directly from inspect to create, only changing
 * the image. No field mapping or stripping.
 *
 * Flow:
 * 1. Stop container
 * 2. Rename to name-old (frees the name for the new container)
 * 3. Disconnect all networks (frees static IPs)
 * 4. Create new container with original name, one network
 * 5. Connect additional networks
 * 6. Start new container
 * 7. Remove old container
 *
 * On failure: rollback (rename old back, reconnect networks, restart old)
 */
export async function recreateContainerFromInspect(
	inspectData: any,
	newImage: string,
	envId?: number | null,
	log?: (msg: string) => void
): Promise<{ Id: string }> {
	const config = inspectData.Config || {};
	const hostConfig = inspectData.HostConfig || {};
	const networks: Record<string, any> = inspectData.NetworkSettings?.Networks || {};
	const name = inspectData.Name?.replace(/^\//, '') || '';
	const oldContainerId = inspectData.Id;
	const wasRunning = inspectData.State?.Running;

	// 1. Stop the container
	if (wasRunning) {
		log?.('Stopping container...');
		await stopContainer(oldContainerId, envId);
	}

	// 2. Rename old container to free the name
	log?.('Renaming old container...');
	await dockerFetch(
		`/containers/${oldContainerId}/rename?name=${encodeURIComponent(name + '-old')}`,
		{ method: 'POST' },
		envId
	).then(r => { if (!r.ok) throw new Error('Failed to rename old container'); });

	// 3. Disconnect all networks from old container (frees static IPs)
	// Capture the first network for use during container creation
	let initialNetworkName: string | null = null;
	let initialNetworkConfig: any = null;

	for (const [netName, netConfig] of Object.entries(networks)) {
		const networkId = (netConfig as any).NetworkID;
		if (networkId) {
			try {
				await disconnectContainerFromNetwork(networkId, oldContainerId, true, envId);
			} catch {
				// Best effort - network may already be disconnected
			}
		}

		// Use first network for creation
		if (!initialNetworkName) {
			initialNetworkName = netName;
			initialNetworkConfig = netConfig;
		}
	}

	// Rollback helper: restore old container on failure
	const rollback = async () => {
		try {
			log?.('Rolling back: restoring old container...');
			// Rename back
			await dockerFetch(
				`/containers/${oldContainerId}/rename?name=${encodeURIComponent(name)}`,
				{ method: 'POST' },
				envId
			).catch(() => {});

			// Reconnect networks using full EndpointSettings from inspect
			for (const [, netConfig] of Object.entries(networks)) {
				const nc = netConfig as any;
				if (nc.NetworkID) {
					await connectContainerToNetworkRaw(nc.NetworkID, oldContainerId, nc, envId).catch(() => {});
				}
			}

			// Restart
			if (wasRunning) {
				await startContainer(oldContainerId, envId).catch(() => {});
			}
		} catch {
			log?.('Rollback failed');
		}
	};

	// 4. Build create config - pass Config and HostConfig directly from inspect
	const createConfig: any = {
		...config,
		Image: newImage,
		HostConfig: hostConfig
	};

	// Preserve anonymous volumes from Mounts not in HostConfig.Binds
	const existingBinds = new Set((hostConfig.Binds || []).map((b: string) => {
		const parts = b.split(':');
		return parts.length >= 2 ? parts[1] : parts[0];
	}));
	const mounts = inspectData.Mounts || [];
	const additionalBinds: string[] = [];
	for (const mount of mounts) {
		if (mount.Type === 'volume' && mount.Name && mount.Destination) {
			if (!existingBinds.has(mount.Destination)) {
				additionalBinds.push(`${mount.Name}:${mount.Destination}`);
			}
		}
	}
	if (additionalBinds.length > 0) {
		createConfig.HostConfig = {
			...hostConfig,
			Binds: [...(hostConfig.Binds || []), ...additionalBinds]
		};
	}

	// Docker can only connect to one network at creation. Pass the first network
	// from the old container's settings to avoid getting a random bridge IP.
	// Clear MacAddress for Docker API < 1.44 compatibility.
	if (initialNetworkName && initialNetworkConfig) {
		const endpointConfig = { ...initialNetworkConfig };
		delete endpointConfig.MacAddress;
		createConfig.NetworkingConfig = {
			EndpointsConfig: {
				[initialNetworkName]: endpointConfig
			}
		};
	}

	// 5. Create new container
	log?.('Creating new container...');
	let newContainerId: string;
	try {
		const result = await dockerJsonRequest<{ Id: string }>(
			`/containers/create?name=${encodeURIComponent(name)}`,
			{
				method: 'POST',
				body: JSON.stringify(createConfig)
			},
			envId
		);
		newContainerId = result.Id;
	} catch (createError: any) {
		log?.(`Create failed: ${createError.message}`);
		await rollback();
		throw createError;
	}

	// 6. Connect additional networks using full EndpointSettings from inspect
	for (const [netName, netConfig] of Object.entries(networks)) {
		if (netName === initialNetworkName) continue; // Already connected at creation

		const nc = netConfig as any;
		if (nc.NetworkID) {
			try {
				await connectContainerToNetworkRaw(nc.NetworkID, newContainerId, nc, envId);
			} catch (netError: any) {
				log?.(`Warning: Failed to connect to network "${netName}": ${netError.message}`);
			}
		}
	}

	// 7. Start new container
	if (wasRunning) {
		log?.('Starting new container...');
		try {
			await startContainer(newContainerId, envId);
		} catch (startError: any) {
			log?.(`Start failed: ${startError.message}, rolling back...`);
			// Remove failed new container
			await removeContainer(newContainerId, true, envId).catch(() => {});
			await rollback();
			throw startError;
		}
	}

	// 8. Log config diff between old and new container
	try {
		const newInspect = await inspectContainer(newContainerId, envId);
		const diffs = deepDiff(inspectData, newInspect);
		if (diffs.length === 0) {
			log?.(`[${name}] Config diff: no differences (all settings preserved)`);
		} else {
			log?.(`[${name}] Config diff: ${diffs.length} difference(s):`);
			for (const d of diffs) {
				log?.(`  [${name}] ${d}`);
			}
		}
	} catch {
		// Non-critical, don't fail the update
	}

	// 9. Remove old container (best effort)
	log?.('Removing old container...');
	await removeContainer(oldContainerId, true, envId).catch(() => {});

	log?.('Container recreated successfully');
	return { Id: newContainerId };
}

/**
 * Extract all container options from Docker inspect data.
 * This preserves ALL container settings for recreation.
 * Used by both updateContainer and recreateContainer to ensure consistency.
 */
export function extractContainerOptions(inspectData: any): CreateContainerOptions {
	const config = inspectData.Config;
	const hostConfig = inspectData.HostConfig;
	const name = inspectData.Name?.replace(/^\//, '') || '';

	// Port bindings - preserve all host port mappings including HostIp
	const ports: { [key: string]: { HostIp?: string; HostPort: string } } = {};
	if (hostConfig.PortBindings) {
		for (const [containerPort, bindings] of Object.entries(hostConfig.PortBindings)) {
			if (bindings && (bindings as any[]).length > 0) {
				const binding = (bindings as any[])[0];
				ports[containerPort] = {
					HostPort: binding.HostPort || ''
				};
				// Preserve HostIp if specified (e.g., '192.168.0.250:80:80' in compose)
				if (binding.HostIp) {
					ports[containerPort].HostIp = binding.HostIp;
				}
			}
		}
	}

	// Volume bindings - preserve ALL volumes including anonymous volumes
	const volumeBinds: string[] = [];
	const mountedPaths = new Set<string>();

	// First, add all entries from hostConfig.Binds (named volumes and bind mounts)
	if (hostConfig.Binds && Array.isArray(hostConfig.Binds)) {
		for (const bind of hostConfig.Binds) {
			volumeBinds.push(bind);
			const parts = bind.split(':');
			if (parts.length >= 2) {
				mountedPaths.add(parts[1].split(':')[0]);
			}
		}
	}

	// Then, add anonymous volumes from Mounts that aren't already in Binds
	const mounts = inspectData.Mounts || [];
	for (const mount of mounts) {
		if (mount.Type === 'volume' && mount.Name && mount.Destination) {
			if (!mountedPaths.has(mount.Destination)) {
				const bindStr = mount.RW === false
					? `${mount.Name}:${mount.Destination}:ro`
					: `${mount.Name}:${mount.Destination}`;
				volumeBinds.push(bindStr);
			}
		}
	}

	// Healthcheck configuration
	let healthcheck: HealthcheckConfig | undefined = undefined;
	if (config.Healthcheck && config.Healthcheck.Test && config.Healthcheck.Test.length > 0) {
		if (config.Healthcheck.Test[0] !== 'NONE') {
			healthcheck = {
				test: config.Healthcheck.Test,
				interval: config.Healthcheck.Interval,
				timeout: config.Healthcheck.Timeout,
				retries: config.Healthcheck.Retries,
				startPeriod: config.Healthcheck.StartPeriod
			};
		}
	}

	// Device mappings
	const devices = (hostConfig.Devices || []).map((d: any) => ({
		hostPath: d.PathOnHost || '',
		containerPath: d.PathInContainer || '',
		permissions: d.CgroupPermissions || 'rwm'
	})).filter((d: any) => d.hostPath && d.containerPath);

	// Ulimits
	const ulimits = (hostConfig.Ulimits || []).map((u: any) => ({
		name: u.Name,
		soft: u.Soft,
		hard: u.Hard
	}));

	// Extract network settings
	const networkSettings = inspectData.NetworkSettings?.Networks || {};
	const primaryNetwork = hostConfig.NetworkMode || 'bridge';

	// Extract primary network aliases, static IP, and gateway priority
	let networkAliases: string[] | undefined;
	let networkIpv4Address: string | undefined;
	let networkIpv6Address: string | undefined;
	let macAddress: string | undefined;
	let networkGwPriority: number | undefined;

	const containerId = inspectData.Id || '';
	const shortContainerId = containerId.substring(0, 12);

	// Extract compose labels for alias reconstruction
	const composeProject = config.Labels?.['com.docker.compose.project'];
	const composeService = config.Labels?.['com.docker.compose.service'];

	for (const [netName, netConfig] of Object.entries(networkSettings)) {
		const netConf = netConfig as any;
		const isPrimary = netName === primaryNetwork ||
			(primaryNetwork === 'bridge' && (netName === 'bridge' || netName === 'default'));

		if (isPrimary) {
			// Filter out auto-generated container IDs
			const allAliases = (netConf.Aliases?.length > 0 ? netConf.Aliases : netConf.DNSNames) || [];
			networkAliases = allAliases.filter((a: string) =>
				a !== containerId && a !== shortContainerId
			);

			// For compose containers, ensure service name and project-service aliases
			if (composeProject && composeService) {
				if (!networkAliases) networkAliases = [];
				if (!networkAliases.includes(composeService)) {
					networkAliases.push(composeService);
				}
				const projectService = `${composeProject}-${composeService}`;
				if (!networkAliases.includes(projectService)) {
					networkAliases.push(projectService);
				}
			}

			if (!networkAliases || networkAliases.length === 0) {
				networkAliases = undefined;
			}

			networkIpv4Address = netConf.IPAMConfig?.IPv4Address || undefined;
			networkIpv6Address = netConf.IPAMConfig?.IPv6Address || undefined;
			macAddress = netConf.MacAddress || undefined;
			networkGwPriority = netConf.GwPriority !== undefined && netConf.GwPriority !== 0
				? netConf.GwPriority : undefined;
			break;
		}
	}

	// Device requests (GPU, etc.)
	const deviceRequests = hostConfig.DeviceRequests?.length > 0
		? hostConfig.DeviceRequests.map((dr: any) => ({
			driver: dr.Driver || undefined,
			count: dr.Count,
			deviceIDs: dr.DeviceIDs?.length > 0 ? dr.DeviceIDs : undefined,
			capabilities: dr.Capabilities?.length > 0 ? dr.Capabilities : undefined,
			options: dr.Options && Object.keys(dr.Options).length > 0 ? dr.Options : undefined
		}))
		: undefined;

	return {
		name,
		image: config.Image,

		// Command and entrypoint
		cmd: config.Cmd || undefined,
		entrypoint: config.Entrypoint || undefined,
		workingDir: config.WorkingDir || undefined,

		// Environment and labels
		env: config.Env || [],
		labels: config.Labels || {},

		// Port mappings
		ports: Object.keys(ports).length > 0 ? ports : undefined,

		// Volume bindings
		volumeBinds: volumeBinds.length > 0 ? volumeBinds : undefined,

		// Restart policy
		restartPolicy: hostConfig.RestartPolicy?.Name || 'no',
		restartMaxRetries: hostConfig.RestartPolicy?.MaximumRetryCount,

		// Network settings
		networkMode: hostConfig.NetworkMode || undefined,
		networkAliases,
		networkIpv4Address,
		networkIpv6Address,
		networkGwPriority,

		// User and hostname
		user: config.User || undefined,
		hostname: config.Hostname || undefined,
		domainname: config.Domainname || undefined,

		// Privileged mode
		privileged: hostConfig.Privileged || undefined,

		// Healthcheck
		healthcheck,

		// Terminal settings
		tty: config.Tty || undefined,
		stdinOpen: config.OpenStdin || undefined,

		// Memory limits
		memory: hostConfig.Memory || undefined,
		memoryReservation: hostConfig.MemoryReservation || undefined,
		memorySwap: hostConfig.MemorySwap || undefined,

		// CPU limits
		cpuShares: hostConfig.CpuShares || undefined,
		cpuQuota: hostConfig.CpuQuota || undefined,
		cpuPeriod: hostConfig.CpuPeriod || undefined,
		nanoCpus: hostConfig.NanoCpus || undefined,

		// Capabilities
		capAdd: hostConfig.CapAdd?.length > 0 ? hostConfig.CapAdd : undefined,
		capDrop: hostConfig.CapDrop?.length > 0 ? hostConfig.CapDrop : undefined,

		// Devices
		devices: devices.length > 0 ? devices : undefined,

		// DNS settings
		dns: hostConfig.Dns?.length > 0 ? hostConfig.Dns : undefined,
		dnsSearch: hostConfig.DnsSearch?.length > 0 ? hostConfig.DnsSearch : undefined,
		dnsOptions: hostConfig.DnsOptions?.length > 0 ? hostConfig.DnsOptions : undefined,

		// Security options
		securityOpt: hostConfig.SecurityOpt?.length > 0 ? hostConfig.SecurityOpt : undefined,

		// Ulimits
		ulimits: ulimits.length > 0 ? ulimits : undefined,

		// Process and memory settings
		oomKillDisable: hostConfig.OomKillDisable || undefined,
		pidsLimit: hostConfig.PidsLimit || undefined,
		shmSize: hostConfig.ShmSize || undefined,

		// Tmpfs mounts
		tmpfs: hostConfig.Tmpfs && Object.keys(hostConfig.Tmpfs).length > 0 ? hostConfig.Tmpfs : undefined,

		// Sysctls
		sysctls: hostConfig.Sysctls && Object.keys(hostConfig.Sysctls).length > 0 ? hostConfig.Sysctls : undefined,

		// Logging configuration
		logDriver: hostConfig.LogConfig?.Type || undefined,
		logOptions: hostConfig.LogConfig?.Config && Object.keys(hostConfig.LogConfig.Config).length > 0
			? hostConfig.LogConfig.Config : undefined,

		// Namespace settings
		ipcMode: hostConfig.IpcMode || undefined,
		pidMode: hostConfig.PidMode || undefined,
		utsMode: hostConfig.UTSMode || undefined,

		// Cgroup parent
		cgroupParent: hostConfig.CgroupParent || undefined,

		// Stop signal and timeout
		stopSignal: config.StopSignal || undefined,
		stopTimeout: config.StopTimeout || undefined,

		// Init process
		init: hostConfig.Init === true ? true : undefined,

		// MAC address
		macAddress,

		// Extra hosts
		extraHosts: hostConfig.ExtraHosts?.length > 0 ? hostConfig.ExtraHosts : undefined,

		// Device requests (GPU)
		deviceRequests,

		// Container runtime
		runtime: hostConfig.Runtime && hostConfig.Runtime !== 'runc' ? hostConfig.Runtime : undefined,

		// Read-only root filesystem
		readonlyRootfs: hostConfig.ReadonlyRootfs === true ? true : undefined,

		// CPU pinning
		cpusetCpus: hostConfig.CpusetCpus || undefined,
		cpusetMems: hostConfig.CpusetMems || undefined,

		// Additional groups
		groupAdd: hostConfig.GroupAdd?.length > 0 ? hostConfig.GroupAdd : undefined,

		// Memory swappiness
		memorySwappiness: hostConfig.MemorySwappiness !== null ? hostConfig.MemorySwappiness : undefined,

		// User namespace mode
		usernsMode: hostConfig.UsernsMode || undefined
	};
}

/**
 * Update a container by recreating it with merged options.
 * Preserves ALL existing container settings and merges user-provided options on top.
 */
export async function updateContainer(id: string, options: Partial<CreateContainerOptions>, startAfterUpdate = false, envId?: number | null) {
	const oldContainerInfo = await inspectContainer(id, envId);
	const wasRunning = oldContainerInfo.State.Running;

	// Extract ALL existing container options
	const existingOptions = extractContainerOptions(oldContainerInfo);

	// Merge user-provided options on top of existing options
	// User options take precedence, but we preserve everything not explicitly provided
	const mergedOptions: CreateContainerOptions = {
		...existingOptions,
		...options,
		// Special handling for labels - merge instead of replace to preserve Docker internal labels
		labels: {
			...existingOptions.labels,
			...options.labels
		}
	};

	if (wasRunning) {
		await stopContainer(id, envId);
	}

	await removeContainer(id, true, envId);

	const newContainer = await createContainer(mergedOptions, envId);

	if (startAfterUpdate || wasRunning) {
		await newContainer.start();
	}

	return newContainer;
}

// Image operations
export async function listImages(envId?: number | null): Promise<ImageInfo[]> {
	// Fetch images and containers in parallel
	const [images, containers] = await Promise.all([
		dockerJsonRequest<any[]>('/images/json', {}, envId),
		dockerJsonRequest<any[]>('/containers/json?all=true', {}, envId).catch(() => [] as any[])
	]);

	// Build a map of imageId -> container count
	// Docker may return -1 for Containers field on some hosts, so we compute it ourselves
	const imageContainerCount = new Map<string, number>();
	for (const container of containers) {
		const imageId = container.ImageID || container.Image;
		if (imageId) {
			imageContainerCount.set(imageId, (imageContainerCount.get(imageId) || 0) + 1);
		}
	}

	return images.map((image) => ({
		id: image.Id,
		repoTags: image.RepoTags || [],
		tags: image.RepoTags || [],
		repoDigests: image.RepoDigests || [],
		size: image.Size,
		virtualSize: image.VirtualSize || image.Size,
		created: image.Created,
		labels: image.Labels || {},
		containers: imageContainerCount.get(image.Id) || 0
	}));
}

export async function pullImage(imageName: string, onProgress?: (data: any) => void, envId?: number | null) {
	// Parse image name and tag to avoid pulling all tags
	// Docker API: if tag is empty, it pulls ALL tags for the image
	// Format can be: repo:tag, repo@digest, or just repo (defaults to :latest)
	let fromImage = imageName;
	let tag = 'latest';

	if (imageName.includes('@')) {
		// Image with digest: repo@sha256:abc123
		// Don't split, pass as-is (digest is part of fromImage)
		fromImage = imageName;
		tag = ''; // Empty tag when using digest
	} else if (imageName.includes(':')) {
		// Image with tag: repo:tag or registry.example.com/repo:tag
		const lastColonIndex = imageName.lastIndexOf(':');
		const potentialTag = imageName.substring(lastColonIndex + 1);
		// Make sure we're not splitting on a port number (e.g., registry.example.com:5000/repo)
		// Tags don't contain slashes, but registry ports are followed by a path
		if (!potentialTag.includes('/')) {
			fromImage = imageName.substring(0, lastColonIndex);
			tag = potentialTag;
		}
	}

	// Build URL with explicit tag parameter to prevent pulling all tags
	const url = tag
		? `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`
		: `/images/create?fromImage=${encodeURIComponent(fromImage)}`;

	// Look up registry credentials for authenticated pulls
	const headers: Record<string, string> = {};
	try {
		const { registry } = parseImageReference(imageName);
		const creds = await findRegistryCredentials(registry);
		if (creds) {
			console.log(`[Pull] Using credentials for ${registry} (user: ${creds.username})`);
			// Docker API expects X-Registry-Auth header with base64-encoded JSON
			const authConfig = {
				username: creds.username,
				password: creds.password,
				serveraddress: registry
			};
			headers['X-Registry-Auth'] = Buffer.from(JSON.stringify(authConfig)).toString('base64');
		} else {
			console.log(`[Pull] No credentials found for ${registry}`);
		}
	} catch (e) {
		const errorMsg = e instanceof Error ? e.message : String(e);
		console.error(`[Pull] Failed to lookup credentials:`, errorMsg);
	}

	// Use streaming: true for longer timeout on edge environments
	const response = await dockerFetch(url, { method: 'POST', streaming: true, headers }, envId);

	if (!response.ok) {
		throw new Error(`Failed to pull image: ${await response.text()}`);
	}

	// Stream the response for progress updates
	const reader = response.body?.getReader();
	if (!reader) return;

	const decoder = new TextDecoder();
	let buffer = '';

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() || '';

		for (const line of lines) {
			if (line.trim()) {
				try {
					const data = JSON.parse(line);
					if (onProgress) onProgress(data);
				} catch {
					// Ignore parse errors
				}
			}
		}
	}
}

export async function removeImage(id: string, force = false, envId?: number | null) {
	const response = await dockerFetch(`/images/${encodeURIComponent(id)}?force=${force}`, { method: 'DELETE' }, envId);
	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		const error: any = new Error(data.message || 'Failed to remove image');
		error.statusCode = response.status;
		error.json = data;
		throw error;
	}
}

export async function getImageHistory(id: string, envId?: number | null) {
	return dockerJsonRequest(`/images/${encodeURIComponent(id)}/history`, {}, envId);
}

export async function inspectImage(id: string, envId?: number | null) {
	return dockerJsonRequest(`/images/${encodeURIComponent(id)}/json`, {}, envId);
}

/**
 * Parse an image reference into registry, repository, and tag components.
 * Follows Docker's reference parsing rules.
 * Examples:
 *   nginx:latest -> { registry: 'index.docker.io', repo: 'library/nginx', tag: 'latest' }
 *   ghcr.io/user/image:v1 -> { registry: 'ghcr.io', repo: 'user/image', tag: 'v1' }
 *   registry.example.com:5000/repo:tag -> { registry: 'registry.example.com:5000', repo: 'repo', tag: 'tag' }
 */
function parseImageReference(imageName: string): { registry: string; repo: string; tag: string } {
	let registry = 'index.docker.io';  // Docker Hub's actual host
	let repo = imageName;
	let tag = 'latest';

	// Handle digest references (remove digest part for manifest lookup)
	if (repo.includes('@')) {
		const [repoWithoutDigest] = repo.split('@');
		repo = repoWithoutDigest;
	}

	// Extract tag
	const lastColon = repo.lastIndexOf(':');
	if (lastColon > -1) {
		const potentialTag = repo.substring(lastColon + 1);
		// Make sure it's not a port number (no slashes in tags)
		if (!potentialTag.includes('/')) {
			tag = potentialTag;
			repo = repo.substring(0, lastColon);
		}
	}

	// Extract registry if present
	const firstSlash = repo.indexOf('/');
	if (firstSlash > -1) {
		const firstPart = repo.substring(0, firstSlash);
		// If the first part contains a dot, colon, or is "localhost", it's a registry
		if (firstPart.includes('.') || firstPart.includes(':') || firstPart === 'localhost') {
			registry = firstPart;
			repo = repo.substring(firstSlash + 1);
		}
	}

	// Normalize docker.io to index.docker.io (Docker Hub's actual registry host)
	// docker.io redirects to www.docker.com, while index.docker.io is the real API
	if (registry === 'docker.io') {
		registry = 'index.docker.io';
	}

	// Docker Hub requires library/ prefix for official images
	if (registry === 'index.docker.io' && !repo.includes('/')) {
		repo = `library/${repo}`;
	}

	return { registry, repo, tag };
}

/**
 * Parse a registry URL into host and path components.
 * Handles URLs with or without protocol, and preserves organization paths.
 *
 * Examples:
 *   'https://registry.example.com/org' -> { host: 'registry.example.com', path: '/org', fullRegistry: 'registry.example.com/org' }
 *   'ghcr.io' -> { host: 'ghcr.io', path: '', fullRegistry: 'ghcr.io' }
 *   'registry.example.com:5000/myorg' -> { host: 'registry.example.com:5000', path: '/myorg', fullRegistry: 'registry.example.com:5000/myorg' }
 */
export function parseRegistryUrl(url: string): { host: string; path: string; fullRegistry: string } {
	// Remove protocol
	const withoutProtocol = url.replace(/^https?:\/\//, '');
	// Remove trailing slash
	const trimmed = withoutProtocol.replace(/\/$/, '');
	// Split on first slash (after port if present)
	const slashIndex = trimmed.indexOf('/');
	if (slashIndex === -1) {
		return { host: trimmed, path: '', fullRegistry: trimmed };
	}
	const host = trimmed.substring(0, slashIndex);
	const path = trimmed.substring(slashIndex); // includes leading /
	return { host, path, fullRegistry: trimmed };
}

/**
 * Find registry credentials from Dockhand's stored registries.
 * Matches by registry URL including organization path if present.
 *
 * Matching logic:
 * - Full match: stored 'registry.example.com/org' matches requested 'registry.example.com/org'
 * - Host-only stored: stored 'registry.example.com' matches requested 'registry.example.com/org'
 *   (allows a single credential entry to work for all org paths)
 */
async function findRegistryCredentials(registryHost: string): Promise<{ username: string; password: string } | null> {
	try {
		// Import here to avoid circular dependency
		const { getRegistries } = await import('./db.js');
		const registries = await getRegistries();

		const requested = parseRegistryUrl(registryHost);

		for (const reg of registries) {
			const stored = parseRegistryUrl(reg.url);

			// Match if:
			// 1. Full registry paths match exactly, OR
			// 2. Hosts match and stored registry has no path (applies to any org)
			if (stored.fullRegistry === requested.fullRegistry ||
			    (stored.host === requested.host && !stored.path)) {
				if (reg.username && reg.password) {
					return { username: reg.username, password: reg.password };
				}
			}
		}

		// Also check for Docker Hub variations
		if (requested.host === 'index.docker.io' || requested.host === 'registry-1.docker.io') {
			for (const reg of registries) {
				const stored = parseRegistryUrl(reg.url);
				// Match all Docker Hub URL variations
				if (stored.host === 'docker.io' || stored.host === 'hub.docker.com' ||
				    stored.host === 'registry.hub.docker.com' || stored.host === 'index.docker.io' ||
				    stored.host === 'registry-1.docker.io') {
					if (reg.username && reg.password) {
						return { username: reg.username, password: reg.password };
					}
				}
			}
		}

		return null;
	} catch (e) {
		const errorMsg = e instanceof Error ? e.message : String(e);
		console.error('[Registry] Failed to lookup credentials:', errorMsg);
		return null;
	}
}

/**
 * Get bearer token from registry using challenge-response flow.
 * This follows the Docker Registry v2 authentication spec:
 * 1. Make request to /v2/ to get WWW-Authenticate challenge
 * 2. Parse realm, service, scope from challenge
 * 3. Request token from realm URL (with credentials if available)
 */
async function getRegistryBearerToken(registry: string, repo: string): Promise<string | null> {
	try {
		const registryUrl = `https://${registry}`;

		// Look up stored credentials for this registry
		const credentials = await findRegistryCredentials(registry);

		// Step 1: Challenge request to /v2/
		const challengeResponse = await fetch(`${registryUrl}/v2/`, {
			method: 'GET',
			headers: { 'User-Agent': 'Dockhand/1.0' }
		});

		// If 200, no auth needed
		if (challengeResponse.ok) {
			return null;
		}

		// If not 401, something else is wrong
		if (challengeResponse.status !== 401) {
			console.error(`Registry challenge failed: ${challengeResponse.status}`);
			return null;
		}

		// Step 2: Parse WWW-Authenticate header
		const wwwAuth = challengeResponse.headers.get('WWW-Authenticate') || '';
		const challenge = wwwAuth.toLowerCase();

		if (challenge.startsWith('basic')) {
			// Basic auth - use credentials if we have them
			if (credentials) {
				const basicAuth = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
				return `Basic ${basicAuth}`;
			}
			return null;
		}

		if (!challenge.startsWith('bearer')) {
			console.error(`Unsupported auth type: ${wwwAuth}`);
			return null;
		}

		// Parse bearer challenge: Bearer realm="...",service="...",scope="..."
		const realmMatch = wwwAuth.match(/realm="([^"]+)"/i);
		const serviceMatch = wwwAuth.match(/service="([^"]+)"/i);

		if (!realmMatch) {
			console.error('No realm in WWW-Authenticate header');
			return null;
		}

		const realm = realmMatch[1];
		const service = serviceMatch ? serviceMatch[1] : '';
		const scope = `repository:${repo}:pull`;

		// Step 3: Request token from realm (with credentials if available)
		const tokenUrl = new URL(realm);
		if (service) tokenUrl.searchParams.set('service', service);
		tokenUrl.searchParams.set('scope', scope);

		const tokenHeaders: Record<string, string> = { 'User-Agent': 'Dockhand/1.0' };

		// Add Basic auth header if we have credentials
		if (credentials) {
			const basicAuth = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
			tokenHeaders['Authorization'] = `Basic ${basicAuth}`;
		}

		const tokenResponse = await fetch(tokenUrl.toString(), {
			headers: tokenHeaders
		});

		if (!tokenResponse.ok) {
			await tokenResponse.text(); // Consume body to release socket
			console.error(`Token request failed: ${tokenResponse.status}`);
			return null;
		}

		const tokenData = await tokenResponse.json() as { token?: string; access_token?: string };
		const token = tokenData.token || tokenData.access_token || null;

		return token ? `Bearer ${token}` : null;

	} catch (e) {
		const errorMsg = e instanceof Error ? e.message : String(e);
		console.error('[Registry] Failed to get bearer token:', errorMsg);
		return null;
	}
}

/**
 * Get authentication header for registry API requests.
 * Handles the Docker Registry V2 OAuth2 token flow:
 * 1. Challenge request to /v2/ to get WWW-Authenticate header
 * 2. Parse realm, service from challenge
 * 3. Request token from realm with credentials (if available)
 *
 * @param registryUrl - Full registry URL (e.g., 'https://ghcr.io' or 'https://registry.example.com/org')
 * @param scope - Token scope (e.g., 'registry:catalog:*' or 'repository:user/repo:pull')
 * @param credentials - Optional credentials { username, password }
 * @returns Authorization header value (e.g., 'Bearer xxx' or 'Basic xxx') or null
 */
export async function getRegistryAuthHeader(
	registryUrl: string,
	scope: string,
	credentials?: { username: string; password: string } | null
): Promise<string | null> {
	try {
		// Parse URL to extract host (V2 API is always at the host root)
		const parsed = parseRegistryUrl(registryUrl);
		const apiBaseUrl = `https://${parsed.host}`;

		// Step 1: Challenge request to /v2/ (always at registry root, not under org path)
		const challengeResponse = await fetch(`${apiBaseUrl}/v2/`, {
			method: 'GET',
			headers: { 'User-Agent': 'Dockhand/1.0' }
		});

		// If 200, no auth needed
		if (challengeResponse.ok) {
			return null;
		}

		// If not 401, something else is wrong
		if (challengeResponse.status !== 401) {
			console.error(`Registry challenge failed: ${challengeResponse.status}`);
			return null;
		}

		// Step 2: Parse WWW-Authenticate header
		const wwwAuth = challengeResponse.headers.get('WWW-Authenticate') || '';
		const challenge = wwwAuth.toLowerCase();

		if (challenge.startsWith('basic')) {
			// Basic auth - use credentials if we have them
			if (credentials) {
				const basicAuth = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
				return `Basic ${basicAuth}`;
			}
			return null;
		}

		if (!challenge.startsWith('bearer')) {
			console.error(`Unsupported auth type: ${wwwAuth}`);
			return null;
		}

		// Parse bearer challenge: Bearer realm="...",service="...",scope="..."
		const realmMatch = wwwAuth.match(/realm="([^"]+)"/i);
		const serviceMatch = wwwAuth.match(/service="([^"]+)"/i);

		if (!realmMatch) {
			console.error('No realm in WWW-Authenticate header');
			return null;
		}

		const realm = realmMatch[1];
		const service = serviceMatch ? serviceMatch[1] : '';

		// Step 3: Request token from realm (with credentials if available)
		const tokenUrl = new URL(realm);
		if (service) tokenUrl.searchParams.set('service', service);
		tokenUrl.searchParams.set('scope', scope);

		const tokenHeaders: Record<string, string> = { 'User-Agent': 'Dockhand/1.0' };

		// Add Basic auth header if we have credentials
		if (credentials) {
			const basicAuth = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
			tokenHeaders['Authorization'] = `Basic ${basicAuth}`;
		}

		const tokenResponse = await fetch(tokenUrl.toString(), {
			headers: tokenHeaders
		});

		if (!tokenResponse.ok) {
			const errorBody = await tokenResponse.text().catch(() => '');
			console.error(`Token request failed: ${tokenResponse.status} - ${errorBody}`);
			return null;
		}

		const tokenData = await tokenResponse.json() as { token?: string; access_token?: string };
		const token = tokenData.token || tokenData.access_token || null;

		return token ? `Bearer ${token}` : null;

	} catch (e) {
		const errorMsg = e instanceof Error ? e.message : String(e);
		console.error('[Registry] Failed to get auth header:', errorMsg);
		return null;
	}
}

/**
 * Helper to get normalized registry URL and auth header for registry API requests.
 * Combines URL normalization, credential extraction, and token flow in one call.
 *
 * @param registry - Registry object from database
 * @param scope - Token scope (e.g., 'registry:catalog:*' or 'repository:user/repo:pull')
 * @returns { baseUrl, orgPath, authHeader } - Base URL (host only for V2 API), org path, and auth header
 */
export async function getRegistryAuth(
	registry: { url: string; username?: string | null; password?: string | null },
	scope: string
): Promise<{ baseUrl: string; orgPath: string; authHeader: string | null }> {
	// Parse registry URL to extract host and organization path
	const parsed = parseRegistryUrl(registry.url);

	// V2 API endpoints are always at the registry host root
	const baseUrl = `https://${parsed.host}`;

	// Get auth header using proper token flow
	const credentials = registry.username && registry.password
		? { username: registry.username, password: registry.password }
		: null;

	const authHeader = await getRegistryAuthHeader(registry.url, scope, credentials);

	return { baseUrl, orgPath: parsed.path, authHeader };
}

/**
 * Check the registry for the current manifest digest of an image.
 * Simple HEAD request to get Docker-Content-Digest header.
 * Docker stores the manifest list digest in RepoDigests, so we compare that directly.
 */
export async function getRegistryManifestDigest(imageName: string): Promise<string | null> {
	try {
		const { registry, repo, tag } = parseImageReference(imageName);
		const token = await getRegistryBearerToken(registry, repo);
		const manifestUrl = `https://${registry}/v2/${repo}/manifests/${tag}`;

		const headers: Record<string, string> = {
			'User-Agent': 'Dockhand/1.0',
			'Accept': [
				'application/vnd.docker.distribution.manifest.list.v2+json',
				'application/vnd.oci.image.index.v1+json',
				'application/vnd.docker.distribution.manifest.v2+json',
				'application/vnd.oci.image.manifest.v1+json'
			].join(', ')
		};
		if (token) headers['Authorization'] = token;

		const response = await fetch(manifestUrl, { method: 'HEAD', headers });

		if (!response.ok) {
			if (response.status !== 429) {
				console.error(`[Registry] ${imageName}: ${response.status}`);
			}
			return null;
		}

		return response.headers.get('Docker-Content-Digest');
	} catch (e) {
		console.error(`[Registry] ${imageName}: ${e}`);
		return null;
	}
}

export interface ImageUpdateCheckResult {
	hasUpdate: boolean;
	currentDigest?: string;
	registryDigest?: string;
	/** True if this is a local-only image (no registry) */
	isLocalImage?: boolean;
	/** Error message if check failed */
	error?: string;
}

/**
 * Check if an image has an update available by comparing local digests against registry.
 * This is a lightweight check that doesn't pull the image.
 *
 * @param imageName - The image name with optional tag (e.g., "nginx:latest")
 * @param currentImageId - The sha256 ID of the current local image
 * @param envId - Optional environment ID for multi-environment support
 * @returns Update check result with hasUpdate flag and digest info
 */
export async function checkImageUpdateAvailable(
	imageName: string,
	currentImageId: string,
	envId?: number
): Promise<ImageUpdateCheckResult> {
	try {
		// Skip update check for digest-pinned images
		// If the user explicitly pins to a digest (image@sha256:...), they don't want auto-updates
		if (isDigestBasedImage(imageName)) {
			return {
				hasUpdate: false,
				currentDigest: imageName.split('@')[1] // Extract the digest part
			};
		}

		// Get current image info to get RepoDigests
		let currentImageInfo: any;
		try {
			currentImageInfo = await inspectImage(currentImageId, envId);
		} catch {
			return { hasUpdate: false, error: 'Could not inspect current image' };
		}

		const currentRepoDigests: string[] = currentImageInfo?.RepoDigests || [];

		// Extract digest part from RepoDigest (format: repo@sha256:...)
		const extractDigest = (rd: string): string | null => {
			const atIndex = rd.lastIndexOf('@');
			return atIndex > -1 ? rd.substring(atIndex + 1) : null;
		};

		// Get ALL local digests - an image can have multiple RepoDigests
		// (e.g., when a tag is updated but the content for your architecture is the same)
		const localDigests = currentRepoDigests
			.map(extractDigest)
			.filter((d): d is string => d !== null);

		// If no local digests, this is likely a local-only image
		if (localDigests.length === 0) {
			return {
				hasUpdate: false,
				isLocalImage: true,
				currentDigest: currentImageId
			};
		}

		// Query registry for current manifest digest
		const registryDigest = await getRegistryManifestDigest(imageName);

		if (!registryDigest) {
			// Registry unreachable or image not found - can't determine update status
			return {
				hasUpdate: false,
				currentDigest: currentRepoDigests[0],
				error: 'Could not query registry'
			};
		}

		// Check if registry digest matches ANY of the local digests
		const matchesLocal = localDigests.includes(registryDigest);
		const hasUpdate = !matchesLocal;

		return {
			hasUpdate,
			currentDigest: currentRepoDigests[0],
			registryDigest: hasUpdate ? registryDigest : undefined
		};
	} catch (e: any) {
		return { hasUpdate: false, error: e.message };
	}
}

export async function tagImage(id: string, repo: string, tag: string, envId?: number | null) {
	const response = await dockerFetch(
		`/images/${encodeURIComponent(id)}/tag?repo=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`,
		{ method: 'POST' },
		envId
	);
	await drainResponse(response);
}

/**
 * Generate a temporary tag name for safe pulling during auto-updates.
 * This allows scanning the new image before committing to the update.
 * @param imageName - The original image name (e.g., "nginx:latest" or "nginx")
 * @returns Temporary tag name (e.g., "nginx:latest-dockhand-pending")
 */
export function getTempImageTag(imageName: string): string {
	// Handle images with digest (e.g., nginx@sha256:abc123)
	if (imageName.includes('@')) {
		// For digest-based images, we can't use temp tags - return as-is
		return imageName;
	}

	// Find the last colon
	const lastColon = imageName.lastIndexOf(':');

	// No colon at all - simple image like "nginx"
	if (lastColon === -1) {
		return `${imageName}:latest-dockhand-pending`;
	}

	const afterColon = imageName.substring(lastColon + 1);

	// If the part after the last colon contains a slash, it's a port number
	// e.g., "registry:5000/nginx" -> afterColon = "5000/nginx"
	// In this case, there's no tag, so we append :latest-dockhand-pending
	if (afterColon.includes('/')) {
		return `${imageName}:latest-dockhand-pending`;
	}

	// Otherwise, the last colon separates repo from tag
	// e.g., "registry.bor6.pl/test:latest" -> repo="registry.bor6.pl/test", tag="latest"
	const repo = imageName.substring(0, lastColon);
	const tag = afterColon;

	return `${repo}:${tag}-dockhand-pending`;
}

/**
 * Check if an image name is using a digest (sha256) instead of a tag.
 * Digest-based images don't need temp tag handling.
 */
export function isDigestBasedImage(imageName: string): boolean {
	return imageName.includes('@sha256:');
}

/**
 * Normalize an image tag for comparison.
 * Docker Hub images can be represented as:
 * - n8nio/n8n:latest
 * - docker.io/n8nio/n8n:latest
 * - docker.io/library/nginx:latest (for official images)
 * - library/nginx:latest
 * - nginx:latest
 * Custom registries:
 * - docker.n8n.io/n8nio/n8n (n8n's custom registry)
 */
function normalizeImageTag(tag: string): string {
	let normalized = tag;
	// Remove docker.io/ prefix
	normalized = normalized.replace(/^docker\.io\//, '');
	// Remove library/ prefix for official images
	normalized = normalized.replace(/^library\//, '');
	// Add :latest if no tag specified (and not a digest)
	if (!normalized.includes(':') && !normalized.includes('@')) {
		normalized = `${normalized}:latest`;
	}
	return normalized.toLowerCase();
}

/**
 * Get image ID by tag name.
 * Uses Docker's image inspect API which correctly resolves any image reference
 * (docker.io, ghcr.io, custom registries, etc.)
 * @returns Image ID (sha256:...) or null if not found
 */
export async function getImageIdByTag(tagName: string, envId?: number | null): Promise<string | null> {
	try {
		// First try: Use Docker's image inspect API - this is the most reliable
		// as Docker knows exactly how to resolve the image name
		const imageInfo = await inspectImage(tagName, envId) as { Id?: string } | null;
		if (imageInfo?.Id) {
			return imageInfo.Id;
		}
	} catch {
		// Image inspect failed - fall back to listing images
	}

	try {
		// Fallback: Search through listed images with normalization
		const images = await listImages(envId);
		const normalizedSearch = normalizeImageTag(tagName);

		for (const image of images) {
			if (image.tags) {
				for (const tag of image.tags) {
					if (normalizeImageTag(tag) === normalizedSearch) {
						return image.id;
					}
				}
			}
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Remove a temporary image by its tag.
 * Used to clean up after a blocked auto-update.
 * @param imageIdOrTag - Image ID or tag to remove
 * @param force - Force removal even if image is in use
 */
export async function removeTempImage(imageIdOrTag: string, envId?: number | null, force = true): Promise<void> {
	try {
		await removeImage(imageIdOrTag, force, envId);
	} catch (error: any) {
		// Log but don't throw - cleanup failure shouldn't break the flow
		console.warn(`[Docker] Failed to remove temp image ${imageIdOrTag}: ${error.message}`);
	}
}

/**
 * Export (save) an image as a tar archive stream.
 * Uses Docker's GET /images/{name}/get endpoint.
 * @returns Response object with tar stream body
 */
export async function exportImage(id: string, envId?: number | null): Promise<Response> {
	const response = await dockerFetch(
		`/images/${encodeURIComponent(id)}/get`,
		{ method: 'GET', streaming: true },
		envId
	);

	if (!response.ok) {
		const error = await response.text().catch(() => 'Unknown error');
		throw new Error(`Failed to export image: ${response.status} - ${error}`);
	}

	return response;
}

// System information
export async function getDockerInfo(envId?: number | null) {
	return dockerJsonRequest('/info', {}, envId);
}

export async function getDockerVersion(envId?: number | null) {
	return dockerJsonRequest('/version', {}, envId);
}

/**
 * Get Hawser agent info (for hawser-standard mode)
 * Returns agent info including uptime
 */
export async function getHawserInfo(envId: number): Promise<{
	agentId: string;
	agentName: string;
	dockerVersion: string;
	hawserVersion: string;
	mode: string;
	uptime: number;
} | null> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const response = await dockerFetch('/_hawser/info', {}, envId);
			if (response.ok) {
				return await response.json();
			}
			console.warn(`[Hawser] Info endpoint returned ${response.status} for env ${envId}`);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.warn(`[Hawser] Failed to fetch info for env ${envId} (attempt ${attempt + 1}): ${msg}`);
		}
	}
	return null;
}

// Volume operations
export interface VolumeInfo {
	name: string;
	driver: string;
	mountpoint: string;
	scope: string;
	created: string;
	labels: { [key: string]: string };
}

export async function listVolumes(envId?: number | null): Promise<VolumeInfo[]> {
	// Fetch volumes and containers in parallel
	const [volumeResult, containers] = await Promise.all([
		dockerJsonRequest<{ Volumes: any[] }>('/volumes', {}, envId),
		dockerJsonRequest<any[]>('/containers/json?all=true', {}, envId)
	]);

	// Build a map of volume name -> containers using it
	const volumeUsageMap = new Map<string, { containerId: string; containerName: string }[]>();

	for (const container of containers) {
		const containerName = container.Names?.[0]?.replace(/^\//, '') || 'unnamed';
		const containerId = container.Id;

		for (const mount of container.Mounts || []) {
			// Check for volume-type mounts (not bind mounts)
			if (mount.Type === 'volume' && mount.Name) {
				const volumeName = mount.Name;
				if (!volumeUsageMap.has(volumeName)) {
					volumeUsageMap.set(volumeName, []);
				}
				volumeUsageMap.get(volumeName)!.push({ containerId, containerName });
			}
		}
	}

	return (volumeResult.Volumes || []).map((volume: any) => ({
		name: volume.Name,
		driver: volume.Driver,
		mountpoint: volume.Mountpoint,
		scope: volume.Scope,
		created: volume.CreatedAt,
		labels: volume.Labels || {},
		usedBy: volumeUsageMap.get(volume.Name) || []
	}));
}

/**
 * Check if a volume is in use by any containers
 * Returns list of containers using the volume
 */
export async function getVolumeUsage(
	volumeName: string,
	envId?: number | null
): Promise<{ containerId: string; containerName: string; state: string }[]> {
	const containers = await dockerJsonRequest<any[]>('/containers/json?all=true', {}, envId);
	const usage: { containerId: string; containerName: string; state: string }[] = [];

	for (const container of containers) {
		// Skip our own helper containers
		if (container.Labels?.['dockhand.volume.helper'] === 'true') {
			continue;
		}

		const containerName = container.Names?.[0]?.replace(/^\//, '') || 'unnamed';
		const containerId = container.Id;
		const state = container.State || 'unknown';

		for (const mount of container.Mounts || []) {
			if (mount.Type === 'volume' && mount.Name === volumeName) {
				usage.push({ containerId, containerName, state });
				break;
			}
		}
	}

	return usage;
}

export async function removeVolume(name: string, force = false, envId?: number | null) {
	const response = await dockerFetch(`/volumes/${encodeURIComponent(name)}?force=${force}`, { method: 'DELETE' }, envId);
	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		const error: any = new Error(data.message || 'Failed to remove volume');
		error.statusCode = response.status;
		error.json = data;
		throw error;
	}
}

export async function inspectVolume(name: string, envId?: number | null) {
	return dockerJsonRequest(`/volumes/${encodeURIComponent(name)}`, {}, envId);
}

export interface CreateVolumeOptions {
	name: string;
	driver?: string;
	driverOpts?: { [key: string]: string };
	labels?: { [key: string]: string };
}

export async function createVolume(options: CreateVolumeOptions, envId?: number | null) {
	const volumeConfig = {
		Name: options.name,
		Driver: options.driver || 'local',
		DriverOpts: options.driverOpts || {},
		Labels: options.labels || {}
	};
	return dockerJsonRequest('/volumes/create', {
		method: 'POST',
		body: JSON.stringify(volumeConfig)
	}, envId);
}

// Network operations
export interface NetworkInfo {
	id: string;
	name: string;
	driver: string;
	scope: string;
	internal: boolean;
	ipam: {
		driver: string;
		config: Array<{ subnet?: string; gateway?: string }>;
	};
	containers: { [key: string]: { name: string; ipv4Address: string } };
}

export async function listNetworks(envId?: number | null): Promise<NetworkInfo[]> {
	const networks = await dockerJsonRequest<any[]>('/networks', {}, envId);

	// Docker's /networks endpoint returns empty Containers - we need to inspect each network
	// to get the actual connected containers. Run inspections in parallel for performance.
	const networkDetails = await Promise.all(
		networks.map(async (network: any) => {
			try {
				const details = await dockerJsonRequest<any>(`/networks/${network.Id}`, {}, envId);
				return {
					...network,
					Containers: details.Containers || {}
				};
			} catch {
				// If inspection fails, return network with empty containers
				return network;
			}
		})
	);

	return networkDetails.map((network: any) => ({
		id: network.Id,
		name: network.Name,
		driver: network.Driver,
		scope: network.Scope,
		internal: network.Internal || false,
		ipam: {
			driver: network.IPAM?.Driver || 'default',
			// Normalize IPAM config field names to lowercase for consistency
			config: (network.IPAM?.Config || []).map((cfg: any) => ({
				subnet: cfg.Subnet || cfg.subnet,
				gateway: cfg.Gateway || cfg.gateway,
				ipRange: cfg.IPRange || cfg.ipRange,
				auxAddress: cfg.AuxAddress || cfg.auxAddress
			}))
		},
		containers: Object.entries(network.Containers || {}).reduce((acc: any, [id, data]: [string, any]) => {
			acc[id] = {
				name: data.Name,
				ipv4Address: data.IPv4Address
			};
			return acc;
		}, {})
	}));
}

export async function removeNetwork(id: string, envId?: number | null) {
	const response = await dockerFetch(`/networks/${id}`, { method: 'DELETE' }, envId);
	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		const error: any = new Error(data.message || 'Failed to remove network');
		error.statusCode = response.status;
		error.json = data;
		throw error;
	}
}

export async function inspectNetwork(id: string, envId?: number | null) {
	return dockerJsonRequest(`/networks/${id}`, {}, envId);
}

export interface CreateNetworkOptions {
	name: string;
	driver?: string;
	internal?: boolean;
	attachable?: boolean;
	ingress?: boolean;
	enableIPv6?: boolean;
	ipam?: {
		driver?: string;
		config?: Array<{
			subnet?: string;
			ipRange?: string;
			gateway?: string;
			auxAddress?: { [key: string]: string };
		}>;
		options?: { [key: string]: string };
	};
	options?: { [key: string]: string };
	labels?: { [key: string]: string };
}

export async function createNetwork(options: CreateNetworkOptions, envId?: number | null) {
	const networkConfig: any = {
		Name: options.name,
		Driver: options.driver || 'bridge',
		Internal: options.internal || false,
		Attachable: options.attachable || false,
		Ingress: options.ingress || false,
		EnableIPv6: options.enableIPv6 || false,
		Options: options.options || {},
		Labels: options.labels || {}
	};

	if (options.ipam) {
		networkConfig.IPAM = {
			Driver: options.ipam.driver || 'default',
			Config: options.ipam.config?.map(cfg => ({
				Subnet: cfg.subnet,
				IPRange: cfg.ipRange,
				Gateway: cfg.gateway,
				AuxiliaryAddresses: cfg.auxAddress
			})).filter(cfg => cfg.Subnet || cfg.Gateway) || [],
			Options: options.ipam.options || {}
		};
	}

	return dockerJsonRequest('/networks/create', {
		method: 'POST',
		body: JSON.stringify(networkConfig)
	}, envId);
}

// Network connect/disconnect operations
export interface NetworkConnectOptions {
	aliases?: string[];
	ipv4Address?: string;
	ipv6Address?: string;
	gwPriority?: number;
}

export async function connectContainerToNetwork(
	networkId: string,
	containerId: string,
	envId?: number | null,
	options?: NetworkConnectOptions
): Promise<void> {
	const body: any = { Container: containerId };

	// Add EndpointConfig for aliases, static IP, and gateway priority
	if (options?.aliases || options?.ipv4Address || options?.ipv6Address || options?.gwPriority !== undefined) {
		body.EndpointConfig = {};

		if (options.aliases && options.aliases.length > 0) {
			body.EndpointConfig.Aliases = options.aliases;
		}

		if (options.ipv4Address || options.ipv6Address) {
			body.EndpointConfig.IPAMConfig = {};
			if (options.ipv4Address) {
				body.EndpointConfig.IPAMConfig.IPv4Address = options.ipv4Address;
			}
			if (options.ipv6Address) {
				body.EndpointConfig.IPAMConfig.IPv6Address = options.ipv6Address;
			}
		}

		// Gateway priority (Docker Engine 28+)
		if (options.gwPriority !== undefined) {
			body.EndpointConfig.GwPriority = options.gwPriority;
		}
	}

	const response = await dockerFetch(
		`/networks/${networkId}/connect`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		},
		envId
	);
	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		throw new Error(data.message || 'Failed to connect container to network');
	}
}

/**
 * Connect a container to a network using a raw EndpointSettings object from inspect data.
 * Passes the full EndpointSettings as-is, preserving all fields (Links, DriverOpts,
 * IPAMConfig.LinkLocalIPs, MacAddress, etc.) without manual field extraction.
 */
export async function connectContainerToNetworkRaw(
	networkId: string,
	containerId: string,
	endpointSettings: any,
	envId?: number | null
): Promise<void> {
	const body: any = {
		Container: containerId,
		EndpointConfig: endpointSettings
	};

	const response = await dockerFetch(
		`/networks/${networkId}/connect`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		},
		envId
	);
	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		throw new Error(data.message || 'Failed to connect container to network');
	}
}

export async function disconnectContainerFromNetwork(
	networkId: string,
	containerId: string,
	force = false,
	envId?: number | null
): Promise<void> {
	const response = await dockerFetch(
		`/networks/${networkId}/disconnect`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ Container: containerId, Force: force })
		},
		envId
	);
	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		throw new Error(data.message || 'Failed to disconnect container from network');
	}
}

// Container exec operations
export interface ExecOptions {
	containerId: string;
	cmd: string[];
	user?: string;
	workingDir?: string;
	envId?: number | null;
}

export async function createExec(options: ExecOptions): Promise<{ Id: string }> {
	const execConfig = {
		Cmd: options.cmd,
		AttachStdin: true,
		AttachStdout: true,
		AttachStderr: true,
		Tty: true,
		User: options.user || 'root',
		WorkingDir: options.workingDir
	};

	return dockerJsonRequest(`/containers/${options.containerId}/exec`, {
		method: 'POST',
		body: JSON.stringify(execConfig)
	}, options.envId);
}

export async function resizeExec(execId: string, cols: number, rows: number, envId?: number | null) {
	try {
		const response = await dockerFetch(`/exec/${execId}/resize?h=${rows}&w=${cols}`, { method: 'POST' }, envId);
		await drainResponse(response);
	} catch {
		// Resize may fail if exec is not running, ignore
	}
}

/**
 * Get Docker connection info for direct WebSocket connections from the client
 * This is used by the terminal to connect directly to the Docker API
 */
export async function getDockerConnectionInfo(envId?: number | null): Promise<{
	type: 'socket' | 'http' | 'https';
	socketPath?: string;
	host?: string;
	port?: number;
}> {
	const config = await getDockerConfig(envId);
	return {
		type: config.type,
		socketPath: config.socketPath,
		host: config.host,
		port: config.port
	};
}

// System disk usage
export async function getDiskUsage(envId?: number | null) {
	return dockerJsonRequest('/system/df', {}, envId);
}

// Prune operations
export async function pruneContainers(envId?: number | null) {
	return dockerJsonRequest('/containers/prune', { method: 'POST' }, envId);
}

export async function pruneImages(dangling = true, envId?: number | null) {
	// dangling=true: only remove untagged images (default Docker behavior)
	// dangling=false: remove ALL unused images including tagged ones
	// Docker API quirk: to remove all unused, we pass dangling=false filter
	const filters = dangling ? '{"dangling":["true"]}' : '{"dangling":["false"]}';
	return dockerJsonRequest(`/images/prune?filters=${encodeURIComponent(filters)}`, { method: 'POST' }, envId);
}

export async function pruneVolumes(envId?: number | null) {
	return dockerJsonRequest('/volumes/prune', { method: 'POST' }, envId);
}

export async function pruneNetworks(envId?: number | null) {
	return dockerJsonRequest('/networks/prune', { method: 'POST' }, envId);
}

export async function pruneAll(envId?: number | null) {
	const containers = await pruneContainers(envId);
	const images = await pruneImages(false, envId);
	const volumes = await pruneVolumes(envId);
	const networks = await pruneNetworks(envId);
	return { containers, images, volumes, networks };
}

// Registry operations
export async function searchImages(term: string, limit = 25, envId?: number | null) {
	return dockerJsonRequest(`/images/search?term=${encodeURIComponent(term)}&limit=${limit}`, {}, envId);
}

// List containers with size info (slower operation)
export async function listContainersWithSize(all = true, envId?: number | null): Promise<Record<string, { sizeRw: number; sizeRootFs: number }>> {
	const containers = await dockerJsonRequest<any[]>(
		`/containers/json?all=${all}&size=true`,
		{},
		envId
	);

	const sizes: Record<string, { sizeRw: number; sizeRootFs: number }> = {};
	for (const container of containers) {
		sizes[container.Id] = {
			sizeRw: container.SizeRw || 0,
			sizeRootFs: container.SizeRootFs || 0
		};
	}
	return sizes;
}

// Get container top (process list)
export async function getContainerTop(id: string, envId?: number | null): Promise<{ Titles: string[]; Processes: string[][] }> {
	return dockerJsonRequest(`/containers/${id}/top`, {}, envId);
}

// Execute a command in a container and return the output
export async function execInContainer(
	containerId: string,
	cmd: string[],
	envId?: number | null
): Promise<string> {
	// Create exec instance
	const execCreate = await dockerJsonRequest<{ Id: string }>(
		`/containers/${containerId}/exec`,
		{
			method: 'POST',
			body: JSON.stringify({
				Cmd: cmd,
				AttachStdout: true,
				AttachStderr: true,
				Tty: false
			})
		},
		envId
	);

	// Start exec and get output
	const response = await dockerFetch(
		`/exec/${execCreate.Id}/start`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ Detach: false, Tty: false })
		},
		envId
	);

	const buffer = Buffer.from(await response.arrayBuffer());
	const output = demuxDockerStream(buffer) as string;

	// Check exit code by inspecting the exec instance
	const execInfo = await dockerJsonRequest<{ ExitCode: number }>(
		`/exec/${execCreate.Id}/json`,
		{},
		envId
	);

	if (execInfo.ExitCode !== 0) {
		const errorMsg = output.trim() || `Command failed with exit code ${execInfo.ExitCode}`;
		throw new Error(errorMsg);
	}

	return output;
}

// Get Docker events as a stream (for SSE)
// For streaming mode: call with just filters
// For polling mode: call with since and until to get a finite window of events
export async function getDockerEvents(
	filters: Record<string, string[]>,
	envId?: number | null,
	options?: { since?: string; until?: string }
): Promise<ReadableStream<Uint8Array> | null> {
	const filterJson = JSON.stringify(filters);

	// Build query string with optional since/until for polling mode
	let queryString = `filters=${encodeURIComponent(filterJson)}`;
	if (options?.since) {
		queryString += `&since=${encodeURIComponent(options.since)}`;
	}
	if (options?.until) {
		queryString += `&until=${encodeURIComponent(options.until)}`;
	}

	try {
		// Note: We use streaming: true to disable Bun's idle timeout for this long-lived connection.
		// The Docker events API keeps the connection open indefinitely, sending events as they occur.
		// Without streaming: true, Bun would terminate the connection after ~5 seconds of inactivity.
		const response = await dockerFetch(
			`/events?${queryString}`,
			{ streaming: true },
			envId
		);

		if (!response.ok) {
			await drainResponse(response);
			throw new Error(`Docker events API returned ${response.status}`);
		}

		return response.body;
	} catch (error: any) {
		throw error;
	}
}

// Check if volume exists
export async function volumeExists(volumeName: string, envId?: number | null): Promise<boolean> {
	try {
		const volumes = await listVolumes(envId);
		return volumes.some(v => v.name === volumeName);
	} catch {
		return false;
	}
}

// Generate a random suffix for container names (avoids conflicts)
function randomSuffix(): string {
	return Math.random().toString(36).substring(2, 8);
}

// Run a short-lived container and return stdout
export async function runContainer(options: {
	image: string;
	cmd: string[];
	binds?: string[];
	env?: string[];
	name?: string;
	envId?: number | null;
}): Promise<{ stdout: string; stderr: string }> {
	// Add random suffix to avoid naming conflicts
	const baseName = options.name || `dockhand-temp-${Date.now()}`;
	const containerName = `${baseName}-${randomSuffix()}`;

	// Create container - disable AutoRemove since we fetch logs after exit
	// and clean up manually. AutoRemove causes race condition where container
	// is removed before we can fetch logs.
	const containerConfig: any = {
		Image: options.image,
		Cmd: options.cmd,
		Env: options.env || [],
		Tty: false,
		HostConfig: {
			Binds: options.binds || [],
			AutoRemove: false // Never use AutoRemove - we clean up manually after fetching logs
		}
	};

	const createResult = await dockerJsonRequest<{ Id: string }>(
		`/containers/create?name=${encodeURIComponent(containerName)}`,
		{
			method: 'POST',
			body: JSON.stringify(containerConfig)
		},
		options.envId
	);

	const containerId = createResult.Id;
	console.log(`[runContainer] Created container ${containerId} for image ${options.image}`);

	try {
		// Start container
		console.log(`[runContainer] Starting container ${containerId}...`);
		await drainResponse(await dockerFetch(`/containers/${containerId}/start`, { method: 'POST' }, options.envId));

		// Wait for container to finish
		console.log(`[runContainer] Waiting for container ${containerId} to finish...`);
		const waitResponse = await dockerFetch(`/containers/${containerId}/wait`, { method: 'POST', streaming: true }, options.envId);
		const waitResult = await waitResponse.json().catch(() => ({}));
		console.log(`[runContainer] Container ${containerId} finished with exit code:`, waitResult?.StatusCode);

		// Get logs - container is stopped but NOT removed yet since AutoRemove is false
		console.log(`[runContainer] Fetching logs for container ${containerId}...`);
		const logsResponse = await dockerFetch(
			`/containers/${containerId}/logs?stdout=true&stderr=true`,
			{},
			options.envId
		);

		const buffer = Buffer.from(await logsResponse.arrayBuffer());
		console.log(`[runContainer] Got logs buffer, size: ${buffer.length} bytes`);

		const result = demuxDockerStream(buffer, { separateStreams: true }) as { stdout: string; stderr: string };
		console.log(`[runContainer] Demuxed: stdout=${result.stdout.length} chars, stderr=${result.stderr.length} chars`);
		if (result.stdout.length === 0 && result.stderr.length === 0 && buffer.length > 0) {
			console.log(`[runContainer] WARNING: Buffer has data but demux returned empty. First 100 bytes:`, buffer.slice(0, 100));
		}
		return result;
	} finally {
		// Always cleanup container manually
		try {
			await drainResponse(await dockerFetch(`/containers/${containerId}?force=true`, { method: 'DELETE' }, options.envId));
		} catch {
			// Ignore cleanup errors
		}
	}
}

// Run a container with attached streams (for scanners that need real-time output)
export async function runContainerWithStreaming(options: {
	image: string;
	cmd: string[];
	binds?: string[];
	env?: string[];
	name?: string;
	user?: string;
	envId?: number | null;
	onStdout?: (data: string) => void;
	onStderr?: (data: string) => void;
	timeout?: number; // Overall timeout in ms (0 or undefined = no timeout)
}): Promise<string> {
	const baseName = options.name || `dockhand-stream-${Date.now()}`;
	const containerName = `${baseName}-${randomSuffix()}`;

	// Create container WITHOUT AutoRemove - we need to fetch logs after it exits
	const containerConfig: any = {
		Image: options.image,
		Cmd: options.cmd,
		Env: options.env || [],
		Tty: false,
		HostConfig: {
			Binds: options.binds || [],
			AutoRemove: false
		}
	};

	// Set user if specified (needed for rootless Docker socket access)
	if (options.user) {
		containerConfig.User = options.user;
	}

	const createResult = await dockerJsonRequest<{ Id: string }>(
		`/containers/create?name=${encodeURIComponent(containerName)}`,
		{ method: 'POST', body: JSON.stringify(containerConfig) },
		options.envId
	);

	const containerId = createResult.Id;
	const config = await getDockerConfig(options.envId ?? undefined);

	try {
		const doWork = async () => {
			// Start container
			await drainResponse(await dockerFetch(`/containers/${containerId}/start`, { method: 'POST' }, options.envId));

			// Create abort controller to cancel stderr stream when container exits
			// On some Docker hosts (e.g. Synology NAS with older kernels), follow=true
			// streams don't close when the container exits, causing indefinite hangs.
			const abortController = new AbortController();

			// Start stderr streaming (non-blocking - may hang on some hosts)
			const stderrPromise = (config.connectionType === 'hawser-edge' && config.environmentId)
				? streamEdgeStderr(config.environmentId, containerId, options.onStderr, abortController.signal)
				: streamLocalStderr(containerId, options.envId, options.onStderr, abortController.signal);
			stderrPromise.catch(() => {}); // Suppress unhandled rejection

			// Wait for container to exit - this is the reliable signal
			let exitCode: number | undefined;
			try {
				const waitResult = await dockerFetch(`/containers/${containerId}/wait`, { method: 'POST', streaming: true }, options.envId);
				const waitData = await waitResult.json() as { StatusCode?: number };
				exitCode = waitData.StatusCode;
				console.log(`[runContainerWithStreaming] Container exited with code: ${exitCode}`);
			} catch (err) {
				console.warn(`[runContainerWithStreaming] Wait warning: ${(err as Error).message}`);
			}

			// Container exited - abort stderr stream (it may be hanging on some Docker hosts)
			abortController.abort();
			// Give brief moment for any final stderr data to flush
			await Promise.race([stderrPromise, new Promise(r => setTimeout(r, 1000))]);

			// Container has exited. Now fetch stdout reliably (no race condition).
			const stdout = await fetchContainerStdout(containerId, config, options.envId);

			// If stdout is empty and exit code is non-zero, fetch stderr for debugging
			if (stdout.length === 0 && exitCode !== 0) {
				try {
					const stderrResponse = await dockerFetch(
						`/containers/${containerId}/logs?stdout=false&stderr=true&follow=false`,
						{},
						options.envId
					);
					const stderrBuffer = Buffer.from(await stderrResponse.arrayBuffer());
					const stderrOutput = demuxDockerStream(stderrBuffer, { separateStreams: true });
					const stderrText = typeof stderrOutput === 'string' ? stderrOutput : stderrOutput.stderr;
					if (stderrText) {
						console.error(`[runContainerWithStreaming] Container stderr: ${stderrText.substring(0, 1000)}`);
					}
				} catch {
					// Ignore stderr fetch errors
				}
			}

			return stdout;
		};

		const effectiveTimeout = options.timeout ?? 0;
		if (effectiveTimeout > 0) {
			return await Promise.race([
				doWork(),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error(
						`Container execution timed out after ${Math.round(effectiveTimeout / 1000)}s`
					)), effectiveTimeout)
				)
			]);
		} else {
			return await doWork();
		}
	} finally {
		// Always cleanup container
		try {
			await drainResponse(await dockerFetch(`/containers/${containerId}?force=true`, { method: 'DELETE' }, options.envId));
		} catch {
			// Ignore cleanup errors
		}
	}
}

// Stream only stderr for real-time progress (local/standard mode)
async function streamLocalStderr(
	containerId: string,
	envId: number | null | undefined,
	onStderr?: (data: string) => void,
	signal?: AbortSignal
): Promise<void> {
	const response = await dockerFetch(
		`/containers/${containerId}/logs?stdout=false&stderr=true&follow=true`,
		{ streaming: true },
		envId
	);

	const reader = response.body?.getReader();
	if (!reader) return;

	// Cancel reader when abort signal fires (container exited)
	signal?.addEventListener('abort', () => reader.cancel(), { once: true });

	try {
		let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer = Buffer.concat([buffer, Buffer.from(value)]);
			const result = processStreamFrames(buffer, undefined, onStderr);
			buffer = result.remaining;
		}
	} catch {
		// Reader was cancelled via abort signal - expected
	}
}

// Stream only stderr for real-time progress (edge mode)
async function streamEdgeStderr(
	environmentId: number,
	containerId: string,
	onStderr?: (data: string) => void,
	signal?: AbortSignal
): Promise<void> {
	return new Promise((resolve, reject) => {
		let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let resolved = false;
		const finish = () => { if (!resolved) { resolved = true; resolve(); } };

		// Resolve when abort signal fires (container exited)
		signal?.addEventListener('abort', finish, { once: true });

		sendEdgeStreamRequest(
			environmentId,
			'GET',
			`/containers/${containerId}/logs?stdout=false&stderr=true&follow=true`,
			{
				onData: (data: string) => {
					if (resolved) return;
					try {
						const decoded = Buffer.from(data, 'base64');
						buffer = Buffer.concat([buffer, decoded]);
						const result = processStreamFrames(buffer, undefined, onStderr);
						buffer = result.remaining;
					} catch {
						// Ignore decode errors
					}
				},
				onEnd: () => finish(),
				onError: (error: string) => {
					// Container exited = success
					if (error.includes('container') && (error.includes('exited') || error.includes('not running'))) {
						finish();
					} else if (!resolved) {
						resolved = true;
						reject(new Error(error));
					}
				}
			}
		);
	});
}

// Extract stdout from a buffer, with raw fallback if frame parsing returns nothing.
// Mirrors demuxDockerStream's fallback (line ~202-205) for non-multiplexed Docker output.
function extractStdoutFromBuffer(buffer: Buffer): string {
	const result = processStreamFrames(buffer, undefined, undefined);

	if (buffer.length > 100000) {
		console.log(
			`[extractStdoutFromBuffer] Raw buffer: ${buffer.length} bytes, stdout: ${result.stdout.length} chars, ` +
			`remaining: ${result.remaining.length} bytes`
		);
	}

	if (result.stdout.length === 0 && buffer.length > 0) {
		console.warn(
			`[extractStdoutFromBuffer] Frame parsing empty but buffer has ${buffer.length} bytes. ` +
			`First 16 bytes: [${Array.from(buffer.slice(0, 16)).join(', ')}]. Falling back to raw.`
		);
		return buffer.toString('utf-8').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
	}

	// If there's remaining data after frame parsing, append it as raw text
	if (result.remaining.length > 0) {
		console.warn(
			`[extractStdoutFromBuffer] ${result.remaining.length} bytes remaining after frame parsing, appending as raw`
		);
		const rawTail = result.remaining.toString('utf-8').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
		return result.stdout + rawTail;
	}

	return result.stdout;
}

// Fetch stdout after container has exited (reliable, no race)
async function fetchContainerStdout(
	containerId: string,
	config: Awaited<ReturnType<typeof getDockerConfig>>,
	envId: number | null | undefined
): Promise<string> {
	if (config.connectionType === 'hawser-edge' && config.environmentId) {
		const response = await sendEdgeRequest(
			config.environmentId,
			'GET',
			`/containers/${containerId}/logs?stdout=true&stderr=false&follow=false`
		);
		if (!response.body) return '';
		const bodyData = typeof response.body === 'string'
			? Buffer.from(response.body, 'base64')
			: Buffer.from(response.body);
		return extractStdoutFromBuffer(bodyData);
	}

	// Local/standard mode - read via streaming to handle large Docker log responses
	const response = await dockerFetch(
		`/containers/${containerId}/logs?stdout=true&stderr=false&follow=false`,
		{},
		envId
	);

	const reader = response.body?.getReader();
	if (!reader) {
		const buffer = Buffer.from(await response.arrayBuffer());
		return extractStdoutFromBuffer(buffer);
	}
	const chunks: Uint8Array[] = [];
	let totalSize = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			chunks.push(value);
			totalSize += value.length;
		}
	}
	const buffer = Buffer.concat(chunks, totalSize);

	return extractStdoutFromBuffer(buffer);
}

// Push image to registry
export async function pushImage(
	imageTag: string,
	authConfig: { username?: string; password?: string; serveraddress: string },
	onProgress?: (data: any) => void,
	envId?: number | null
): Promise<void> {
	// Parse tag to get registry info
	const [repo, tag = 'latest'] = imageTag.split(':');

	// Create X-Registry-Auth header
	const authHeader = Buffer.from(JSON.stringify(authConfig)).toString('base64');

	const response = await dockerFetch(
		`/images/${encodeURIComponent(imageTag)}/push`,
		{
			method: 'POST',
			headers: {
				'X-Registry-Auth': authHeader
			}
		},
		envId
	);

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Failed to push image: ${error}`);
	}

	// Stream the response for progress updates
	const reader = response.body?.getReader();
	if (!reader) return;

	const decoder = new TextDecoder();
	let buffer = '';

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() || '';

		for (const line of lines) {
			if (line.trim()) {
				try {
					const data = JSON.parse(line);
					if (data.error) {
						throw new Error(data.error);
					}
					if (onProgress) onProgress(data);
				} catch (e: any) {
					if (e.message && !e.message.includes('JSON')) {
						throw e;
					}
				}
			}
		}
	}
}

// Container filesystem operations
export interface FileEntry {
	name: string;
	type: 'file' | 'directory' | 'symlink' | 'other';
	size: number;
	permissions: string;
	owner: string;
	group: string;
	modified: string;
	linkTarget?: string;
	readonly?: boolean;
}

/**
 * Parse ls -la output into FileEntry array
 * Handles multiple formats:
 * - GNU ls with --time-style=iso: drwxr-xr-x 2 root root 4096 2024-12-08 10:30 dirname
 * - Standard GNU ls: drwxr-xr-x  2 root root  4096 Dec  8 10:30 dirname
 * - Busybox ls: drwxr-xr-x    2 root     root          4096 Dec  8 10:30 dirname
 */
function parseLsOutput(output: string): FileEntry[] {
	const lines = output.trim().split('\n');
	const entries: FileEntry[] = [];
	const currentYear = new Date().getFullYear();

	// Month name to number mapping
	const monthMap: Record<string, string> = {
		Jan: '01',
		Feb: '02',
		Mar: '03',
		Apr: '04',
		May: '05',
		Jun: '06',
		Jul: '07',
		Aug: '08',
		Sep: '09',
		Oct: '10',
		Nov: '11',
		Dec: '12'
	};

	for (const line of lines) {
		// Skip total line, empty lines, and error messages
		if (!line || line.startsWith('total ') || line.includes('cannot access') || line.includes('Permission denied')) continue;

		let typeChar: string;
		let perms: string;
		let owner: string;
		let group: string;
		let sizeStr: string;
		let date: string;
		let time: string;
		let nameAndLink: string;

		// Try ISO format first (GNU ls with --time-style=iso)
		// Format: drwxr-xr-x 2 root root 4096 2024-12-08 10:30 dirname
		// With ACL: drwxr-xr-x+ 2 root root 4096 2024-12-08 10:30 dirname
		// With extended attrs: drwxr-xr-x@ 2 root root 4096 2024-12-08 10:30 dirname
		const isoMatch = line.match(
			/^([dlcbps-])([rwxsStT-]{9})[+@.]?\s+\d+\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d{2,4}-\d{2}(?:-\d{2})?)\s+(\d{2}:\d{2})\s+(.+)$/
		);

		if (isoMatch) {
			[, typeChar, perms, owner, group, sizeStr, date, time, nameAndLink] = isoMatch;
			// Normalize date to YYYY-MM-DD format
			if (date.length <= 5) {
				// Format: MM-DD (no year)
				date = `${currentYear}-${date}`;
			} else if (!date.includes('-', 4)) {
				// Format: YYYY-MM (no day)
				date = `${date}-01`;
			}
		} else {
			// Try standard format (GNU/busybox without --time-style)
			// Format: drwxr-xr-x  2 root root  4096 Dec  8 10:30 dirname
			// Or:     drwxr-xr-x    2 root     root          4096 Dec  8 10:30 dirname
			// Or with year: drwxr-xr-x  2 root root  4096 Dec  8  2023 dirname
			// With ACL/attrs: drwxr-xr-x+ or drwxr-xr-x@ or drwxr-xr-x.
			const stdMatch = line.match(
				/^([dlcbps-])([rwxsStT-]{9})[+@.]?\s+\d+\s+(\S+)\s+(\S+)\s+(\d+)\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}:\d{2}|\d{4})\s+(.+)$/
			);

			if (!stdMatch) {
				// Try device file format (block/char devices have major,minor instead of size)
				// Format: crw-rw-rw- 1 root root 1, 3 Dec  8 10:30 null
				const deviceMatch = line.match(
					/^([cb])([rwxsStT-]{9})[+@.]?\s+\d+\s+(\S+)\s+(\S+)\s+(\d+),\s*(\d+)\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}:\d{2}|\d{4})\s+(.+)$/
				);

				if (deviceMatch) {
					let monthStr: string;
					let dayStr: string;
					let timeOrYear: string;
					[, typeChar, perms, owner, group, , , monthStr, dayStr, timeOrYear, nameAndLink] = deviceMatch;
					sizeStr = '0'; // Device files don't have a traditional size

					const month = monthMap[monthStr] || '01';
					const day = dayStr.padStart(2, '0');

					if (timeOrYear.includes(':')) {
						time = timeOrYear;
						date = `${currentYear}-${month}-${day}`;
					} else {
						time = '00:00';
						date = `${timeOrYear}-${month}-${day}`;
					}
				} else {
					continue;
				}
			} else {
				let monthStr: string;
				let dayStr: string;
				let timeOrYear: string;
				[, typeChar, perms, owner, group, sizeStr, monthStr, dayStr, timeOrYear, nameAndLink] =
					stdMatch;

				const month = monthMap[monthStr] || '01';
				const day = dayStr.padStart(2, '0');

				// timeOrYear is either "HH:MM" or "YYYY"
				if (timeOrYear.includes(':')) {
					time = timeOrYear;
					date = `${currentYear}-${month}-${day}`;
				} else {
					time = '00:00';
					date = `${timeOrYear}-${month}-${day}`;
				}
			}
		}

		let type: FileEntry['type'];
		switch (typeChar) {
			case 'd':
				type = 'directory';
				break;
			case 'l':
				type = 'symlink';
				break;
			case '-':
				type = 'file';
				break;
			default:
				type = 'other';
		}

		let name = nameAndLink;
		let linkTarget: string | undefined;

		// Handle symlinks: "name -> target"
		if (type === 'symlink' && nameAndLink.includes(' -> ')) {
			const parts = nameAndLink.split(' -> ');
			name = parts[0];
			linkTarget = parts.slice(1).join(' -> ');
		}

		// Skip . and .. entries
		if (name === '.' || name === '..') continue;

		// Check if file is read-only (owner doesn't have write permission)
		// perms format: rwxrwxrwx - index 1 is owner write
		const isReadonly = perms.charAt(1) !== 'w';

		entries.push({
			name,
			type,
			size: parseInt(sizeStr, 10),
			permissions: perms,
			owner,
			group,
			modified: `${date}T${time}:00`,
			linkTarget,
			readonly: isReadonly
		});
	}

	return entries;
}

/**
 * List files in a container directory
 * Tries multiple ls command variants for compatibility with different containers.
 */
export async function listContainerDirectory(
	containerId: string,
	path: string,
	envId?: number | null,
	useSimpleLs?: boolean
): Promise<{ path: string; entries: FileEntry[] }> {
	// Sanitize path to prevent command injection
	const safePath = path.replace(/[;&|`$(){}[\]<>'"\\]/g, '');

	// Commands to try in order of preference
	const commands = useSimpleLs
		? [
			['ls', '-la', safePath],
			['/bin/ls', '-la', safePath],
			['/usr/bin/ls', '-la', safePath],
		]
		: [
			['ls', '-la', '--time-style=iso', safePath],
			['ls', '-la', safePath],
			['/bin/ls', '-la', safePath],
			['/usr/bin/ls', '-la', safePath],
		];

	let lastError: Error | null = null;

	for (const cmd of commands) {
		try {
			const output = await execInContainer(containerId, cmd, envId);
			const entries = parseLsOutput(output);
			return { path: safePath, entries };
		} catch (err: any) {
			lastError = err;
			continue;
		}
	}

	throw lastError || new Error('Failed to list directory: no working ls command found');
}

/**
 * Get file/directory archive from container (for download)
 * Returns the raw Docker API response for streaming
 */
export async function getContainerArchive(
	containerId: string,
	path: string,
	envId?: number | null
): Promise<Response> {
	// Sanitize path
	const safePath = path.replace(/[;&|`$(){}[\]<>'"\\]/g, '');

	const response = await dockerFetch(
		`/containers/${containerId}/archive?path=${encodeURIComponent(safePath)}`,
		{},
		envId
	);

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Failed to get archive: ${error}`);
	}

	return response;
}

/**
 * Upload files to container (tar archive)
 */
export async function putContainerArchive(
	containerId: string,
	path: string,
	tarData: ArrayBuffer | Uint8Array,
	envId?: number | null
): Promise<void> {
	// Sanitize path
	const safePath = path.replace(/[;&|`$(){}[\]<>'"\\]/g, '');

	const response = await dockerFetch(
		`/containers/${containerId}/archive?path=${encodeURIComponent(safePath)}`,
		{
			method: 'PUT',
			headers: {
				'Content-Type': 'application/x-tar'
			},
			body: tarData as BodyInit
		},
		envId
	);

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Failed to upload archive: ${error}`);
	}
}

/**
 * Get stat info for a file/directory in container
 */
export async function statContainerPath(
	containerId: string,
	path: string,
	envId?: number | null
): Promise<{ name: string; size: number; mode: number; mtime: string; linkTarget?: string }> {
	// Sanitize path
	const safePath = path.replace(/[;&|`$(){}[\]<>'"\\]/g, '');

	const response = await dockerFetch(
		`/containers/${containerId}/archive?path=${encodeURIComponent(safePath)}`,
		{ method: 'HEAD' },
		envId
	);

	if (!response.ok) {
		throw new Error(`Path not found: ${safePath}`);
	}

	// Docker returns stat info in X-Docker-Container-Path-Stat header as base64 JSON
	const statHeader = response.headers.get('X-Docker-Container-Path-Stat');
	if (!statHeader) {
		throw new Error('No stat info returned');
	}

	const statJson = Buffer.from(statHeader, 'base64').toString('utf-8');
	return JSON.parse(statJson);
}

/**
 * Read file content from container
 * Uses cat command via exec to read file contents
 */
export async function readContainerFile(
	containerId: string,
	path: string,
	envId?: number | null
): Promise<string> {
	// Sanitize path to prevent command injection
	const safePath = path.replace(/[;&|`$(){}[\]<>'"\\]/g, '');

	// Use cat to read file content
	const output = await execInContainer(containerId, ['cat', safePath], envId);
	return output;
}

/**
 * Write file content to container
 * Uses Docker archive API to write file
 */
export async function writeContainerFile(
	containerId: string,
	path: string,
	content: string,
	envId?: number | null
): Promise<void> {
	// Sanitize path
	const safePath = path.replace(/[;&|`$(){}[\]<>'"\\]/g, '');

	// Get directory and filename
	const parts = safePath.split('/');
	const filename = parts.pop() || 'file';
	const directory = parts.join('/') || '/';

	// Create a minimal tar archive with the file
	// Tar format: 512-byte header + file content + padding to 512-byte boundary
	const contentBytes = new TextEncoder().encode(content);
	const fileSize = contentBytes.length;

	// Calculate total tar size (header + content + padding + two 512-byte end blocks)
	const paddedContentSize = Math.ceil(fileSize / 512) * 512;
	const tarSize = 512 + paddedContentSize + 1024; // header + padded content + end blocks

	const tarData = new Uint8Array(tarSize);

	// Write tar header (512 bytes)
	// File name (100 bytes)
	const filenameBytes = new TextEncoder().encode(filename);
	tarData.set(filenameBytes.slice(0, 100), 0);

	// File mode (8 bytes octal) - 0644
	tarData.set(new TextEncoder().encode('0000644\0'), 100);

	// UID (8 bytes octal) - 0
	tarData.set(new TextEncoder().encode('0000000\0'), 108);

	// GID (8 bytes octal) - 0
	tarData.set(new TextEncoder().encode('0000000\0'), 116);

	// File size (12 bytes octal)
	const sizeOctal = fileSize.toString(8).padStart(11, '0') + '\0';
	tarData.set(new TextEncoder().encode(sizeOctal), 124);

	// Mtime (12 bytes octal) - current time
	const mtime = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0';
	tarData.set(new TextEncoder().encode(mtime), 136);

	// Checksum placeholder (8 bytes) - filled with spaces initially
	tarData.set(new TextEncoder().encode('        '), 148);

	// Type flag (1 byte) - '0' for regular file
	tarData[156] = 48; // ASCII '0'

	// Link name (100 bytes) - empty for regular files
	// Already zeros

	// USTAR magic (6 bytes) + version (2 bytes)
	tarData.set(new TextEncoder().encode('ustar\0'), 257);
	tarData.set(new TextEncoder().encode('00'), 263);

	// Owner name (32 bytes) - root
	tarData.set(new TextEncoder().encode('root'), 265);

	// Group name (32 bytes) - root
	tarData.set(new TextEncoder().encode('root'), 297);

	// Calculate and write checksum
	let checksum = 0;
	for (let i = 0; i < 512; i++) {
		checksum += tarData[i];
	}
	const checksumOctal = checksum.toString(8).padStart(6, '0') + '\0 ';
	tarData.set(new TextEncoder().encode(checksumOctal), 148);

	// Write file content after header
	tarData.set(contentBytes, 512);

	// Upload to container
	await putContainerArchive(containerId, directory, tarData, envId);
}

/**
 * Create an empty file in container
 */
export async function createContainerFile(
	containerId: string,
	path: string,
	envId?: number | null
): Promise<void> {
	// Sanitize path to prevent command injection
	const safePath = path.replace(/[;&|`$(){}[\]<>'"\\]/g, '');

	// Use touch to create empty file
	await execInContainer(containerId, ['touch', safePath], envId);
}

/**
 * Create a directory in container
 */
export async function createContainerDirectory(
	containerId: string,
	path: string,
	envId?: number | null
): Promise<void> {
	// Sanitize path to prevent command injection
	const safePath = path.replace(/[;&|`$(){}[\]<>'"\\]/g, '');

	// Use mkdir -p to create directory (and parents if needed)
	await execInContainer(containerId, ['mkdir', '-p', safePath], envId);
}

/**
 * Delete a file or directory in container
 */
export async function deleteContainerPath(
	containerId: string,
	path: string,
	envId?: number | null
): Promise<void> {
	// Sanitize path to prevent command injection
	const safePath = path.replace(/[;&|`$(){}[\]<>'"\\]/g, '');

	// Safety check: don't allow deleting root or critical paths
	const dangerousPaths = ['/', '/bin', '/sbin', '/usr', '/lib', '/lib64', '/etc', '/var', '/root', '/home'];
	if (dangerousPaths.includes(safePath) || safePath === '') {
		throw new Error('Cannot delete critical system path');
	}

	// Use rm -rf to delete file or directory
	await execInContainer(containerId, ['rm', '-rf', safePath], envId);
}

/**
 * Rename/move a file or directory in container
 */
export async function renameContainerPath(
	containerId: string,
	oldPath: string,
	newPath: string,
	envId?: number | null
): Promise<void> {
	// Sanitize paths to prevent command injection
	const safeOldPath = oldPath.replace(/[;&|`$(){}[\]<>'"\\]/g, '');
	const safeNewPath = newPath.replace(/[;&|`$(){}[\]<>'"\\]/g, '');

	// Use mv to rename
	await execInContainer(containerId, ['mv', safeOldPath, safeNewPath], envId);
}

/**
 * Change permissions of a file or directory in container
 */
export async function chmodContainerPath(
	containerId: string,
	path: string,
	mode: string,
	recursive: boolean = false,
	envId?: number | null
): Promise<void> {
	// Sanitize path to prevent command injection
	const safePath = path.replace(/[;&|`$(){}[\]<>'"\\]/g, '');

	// Validate mode (should be octal like 755 or symbolic like u+x)
	if (!/^[0-7]{3,4}$/.test(mode) && !/^[ugoa]*[+-=][rwxXst]+$/.test(mode)) {
		throw new Error('Invalid chmod mode');
	}

	// Build command
	const cmd = recursive ? ['chmod', '-R', mode, safePath] : ['chmod', mode, safePath];
	await execInContainer(containerId, cmd, envId);
}

// Volume browsing and export helpers

const VOLUME_HELPER_IMAGE = 'busybox:latest';
const VOLUME_MOUNT_PATH = '/volume';
const VOLUME_HELPER_TTL_SECONDS = 300; // 5 minutes TTL for helper containers

// Cache for volume helper containers: key = `${volumeName}:${envId ?? 'local'}` -> containerId
const volumeHelperCache = new Map<string, { containerId: string; expiresAt: number }>();

/**
 * Get cache key for a volume helper container
 */
function getVolumeCacheKey(volumeName: string, envId?: number | null): string {
	return `${volumeName}:${envId ?? 'local'}`;
}

/**
 * Ensure the volume helper image (busybox) is available, pulling if necessary
 */
async function ensureVolumeHelperImage(envId?: number | null): Promise<void> {
	// Check if image exists
	const response = await dockerFetch(`/images/${encodeURIComponent(VOLUME_HELPER_IMAGE)}/json`, {}, envId);

	if (response.ok) {
		return; // Image exists
	}

	// Image not found, pull it
	console.log(`Pulling ${VOLUME_HELPER_IMAGE} for volume browsing...`);
	const pullResponse = await dockerFetch(
		`/images/create?fromImage=${encodeURIComponent(VOLUME_HELPER_IMAGE)}`,
		{ method: 'POST' },
		envId
	);

	if (!pullResponse.ok) {
		const error = await pullResponse.text();
		throw new Error(`Failed to pull ${VOLUME_HELPER_IMAGE}: ${error}`);
	}

	// Wait for pull to complete by consuming the stream
	const reader = pullResponse.body?.getReader();
	if (reader) {
		while (true) {
			const { done } = await reader.read();
			if (done) break;
		}
	}

	console.log(`Successfully pulled ${VOLUME_HELPER_IMAGE}`);
}

/**
 * Check if a container exists and is running
 */
async function isContainerRunning(containerId: string, envId?: number | null): Promise<boolean> {
	try {
		const response = await dockerFetch(`/containers/${containerId}/json`, {}, envId);
		if (!response.ok) {
			await response.text(); // Consume body to release socket
			return false;
		}
		const info = await response.json();
		return info.State?.Running === true;
	} catch {
		return false;
	}
}

/**
 * Get or create a helper container for volume browsing.
 * Reuses existing containers from cache for better performance.
 * Returns the container ID.
 * @param readOnly - If true, mount volume read-only (default). If false, mount writable.
 */
export async function getOrCreateVolumeHelperContainer(
	volumeName: string,
	envId?: number | null,
	readOnly: boolean = true
): Promise<string> {
	// Include readOnly in cache key since we need different containers for ro/rw
	const cacheKey = `${getVolumeCacheKey(volumeName, envId)}:${readOnly ? 'ro' : 'rw'}`;
	const now = Date.now();

	// Check cache for existing container
	const cached = volumeHelperCache.get(cacheKey);
	if (cached && cached.expiresAt > now) {
		// Verify container is still running
		if (await isContainerRunning(cached.containerId, envId)) {
			// Refresh expiry time on access
			cached.expiresAt = now + VOLUME_HELPER_TTL_SECONDS * 1000;
			return cached.containerId;
		}
		// Container no longer running, remove from cache
		volumeHelperCache.delete(cacheKey);
	}

	// Ensure helper image is available (auto-pull if missing)
	await ensureVolumeHelperImage(envId);

	// Generate a unique container name based on volume name
	const safeVolumeName = volumeName.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 50);
	const rwSuffix = readOnly ? 'ro' : 'rw';
	const containerName = `dockhand-browse-${safeVolumeName}-${rwSuffix}-${Date.now().toString(36)}`;

	// Create a temporary container with the volume mounted
	const bindMount = readOnly
		? `${volumeName}:${VOLUME_MOUNT_PATH}:ro`
		: `${volumeName}:${VOLUME_MOUNT_PATH}`;

	const containerConfig = {
		Image: VOLUME_HELPER_IMAGE,
		Cmd: ['sleep', 'infinity'], // Keep alive indefinitely (managed by cache TTL)
		HostConfig: {
			Binds: [bindMount],
			AutoRemove: false
		},
		Labels: {
			'dockhand.volume.helper': 'true',
			'dockhand.volume.name': volumeName,
			'dockhand.volume.readonly': String(readOnly)
		}
	};

	const response = await dockerJsonRequest<{ Id: string }>(
		`/containers/create?name=${encodeURIComponent(containerName)}`,
		{
			method: 'POST',
			body: JSON.stringify(containerConfig)
		},
		envId
	);

	const containerId = response.Id;

	// Start the container
	await drainResponse(await dockerFetch(`/containers/${containerId}/start`, { method: 'POST' }, envId));

	// Cache the container
	volumeHelperCache.set(cacheKey, {
		containerId,
		expiresAt: now + VOLUME_HELPER_TTL_SECONDS * 1000
	});

	return containerId;
}

/**
 * @deprecated Use getOrCreateVolumeHelperContainer instead
 * Create a temporary container with a volume mounted for browsing/export
 * Returns the container ID. Caller is responsible for removing the container.
 */
export async function createVolumeHelperContainer(
	volumeName: string,
	envId?: number | null
): Promise<string> {
	return getOrCreateVolumeHelperContainer(volumeName, envId);
}

/**
 * Release a cached volume helper container when done browsing.
 * This removes the container from cache and stops/removes it from Docker.
 * Cleans up both ro and rw variants if they exist.
 */
export async function releaseVolumeHelperContainer(
	volumeName: string,
	envId?: number | null
): Promise<void> {
	const baseCacheKey = getVolumeCacheKey(volumeName, envId);

	// Clean up both read-only and read-write variants
	for (const suffix of [':ro', ':rw']) {
		const cacheKey = baseCacheKey + suffix;
		const cached = volumeHelperCache.get(cacheKey);

		if (cached) {
			volumeHelperCache.delete(cacheKey);
			await removeVolumeHelperContainer(cached.containerId, envId).catch(err => {
				console.warn('Failed to cleanup volume helper container:', err);
			});
		}
	}
}

/**
 * Cleanup expired volume helper containers.
 * Called periodically to remove containers that have exceeded their TTL.
 */
export async function cleanupExpiredVolumeHelpers(): Promise<void> {
	const now = Date.now();
	const expiredEntries: Array<{ key: string; containerId: string; envId?: number | null }> = [];

	for (const [key, cached] of volumeHelperCache.entries()) {
		if (cached.expiresAt <= now) {
			// Parse envId from key: "volumeName:envId" or "volumeName:local"
			const [, envIdStr] = key.split(':');
			const envId = envIdStr === 'local' ? null : parseInt(envIdStr);
			expiredEntries.push({ key, containerId: cached.containerId, envId });
		}
	}

	// Remove from cache and cleanup containers
	for (const { key, containerId, envId } of expiredEntries) {
		volumeHelperCache.delete(key);
		removeVolumeHelperContainer(containerId, envId ?? undefined).catch(err => {
			console.warn('Failed to cleanup expired volume helper container:', err);
		});
	}

	if (expiredEntries.length > 0) {
		console.log(`Cleaned up ${expiredEntries.length} expired volume helper container(s)`);
	}
}

/**
 * Remove a volume helper container
 */
export async function removeVolumeHelperContainer(
	containerId: string,
	envId?: number | null
): Promise<void> {
	try {
		// Stop the container first (force)
		await drainResponse(await dockerFetch(`/containers/${containerId}/stop?t=1`, { method: 'POST' }, envId));
	} catch {
		// Ignore stop errors
	}

	// Remove the container
	await drainResponse(await dockerFetch(`/containers/${containerId}?force=true`, { method: 'DELETE' }, envId));
}

/**
 * Cleanup all stale volume helper containers on a specific environment.
 * Finds containers with label dockhand.volume.helper=true and removes them.
 * Called on startup to clean up containers from previous process runs.
 */
async function cleanupStaleVolumeHelpersForEnv(envId?: number | null): Promise<number> {
	try {
		// Query containers with our helper label
		const filters = JSON.stringify({ label: ['dockhand.volume.helper=true'] });
		const response = await dockerFetch(
			`/containers/json?all=true&filters=${encodeURIComponent(filters)}`,
			{},
			envId
		);

		if (!response.ok) {
			await response.text(); // Consume body to release socket
			return 0;
		}

		const containers: Array<{ Id: string; Names: string[] }> = await response.json();
		let removed = 0;

		for (const container of containers) {
			try {
				await removeVolumeHelperContainer(container.Id, envId);
				removed++;
			} catch (err) {
				console.warn(`Failed to remove stale helper container ${container.Names?.[0] || container.Id}:`, err);
			}
		}

		return removed;
	} catch (err: any) {
		// Don't spam logs for expected failures (e.g., edge agent offline)
		const msg = err?.message || String(err);
		if (!msg.includes('not connected') && !msg.includes('offline')) {
			console.warn('Failed to query stale volume helpers:', msg);
		}
		return 0;
	}
}

/**
 * Cleanup stale volume helper containers across all environments.
 * Should be called on startup to clean up orphaned containers.
 * @param environments - Optional pre-fetched environments (avoids dynamic import in production)
 */
export async function cleanupStaleVolumeHelpers(environments: Array<{ id: number }>): Promise<void> {
	console.log('Cleaning up stale volume helper containers...');

	if (!environments || environments.length === 0) {
		console.log('No environments to clean up');
		return;
	}

	let totalRemoved = 0;

	// Clean up all configured environments
	for (const env of environments) {
		totalRemoved += await cleanupStaleVolumeHelpersForEnv(env.id);
	}

	if (totalRemoved > 0) {
		console.log(`Removed ${totalRemoved} stale volume helper container(s)`);
	}
}

/**
 * List directory contents in a volume
 * Uses cached helper containers for better performance.
 */
export async function listVolumeDirectory(
	volumeName: string,
	path: string,
	envId?: number | null,
	readOnly: boolean = true
): Promise<{ path: string; entries: FileEntry[]; containerId: string }> {
	const containerId = await getOrCreateVolumeHelperContainer(volumeName, envId, readOnly);

	// Sanitize path
	const safePath = path.replace(/[;&|`$(){}[\]<>'"\\]/g, '');
	const fullPath = `${VOLUME_MOUNT_PATH}${safePath.startsWith('/') ? safePath : '/' + safePath}`;

	// Use simple ls since busybox doesn't support --time-style
	const output = await execInContainer(containerId, ['ls', '-la', fullPath], envId);
	const entries = parseLsOutput(output);

	return {
		path: safePath || '/',
		entries,
		containerId
	};
	// Note: Container is kept alive for reuse. It will be cleaned up
	// when the cache TTL expires or when the volume browser modal closes.
}

/**
 * Get archive of volume contents for download
 * Uses cached helper containers for better performance.
 */
export async function getVolumeArchive(
	volumeName: string,
	path: string,
	envId?: number | null,
	readOnly: boolean = true
): Promise<{ response: Response; containerId: string }> {
	const containerId = await getOrCreateVolumeHelperContainer(volumeName, envId, readOnly);

	// Sanitize path
	const safePath = path.replace(/[;&|`$(){}[\]<>'"\\]/g, '');
	const fullPath = `${VOLUME_MOUNT_PATH}${safePath.startsWith('/') ? safePath : '/' + safePath}`;

	const response = await dockerFetch(
		`/containers/${containerId}/archive?path=${encodeURIComponent(fullPath)}`,
		{},
		envId
	);

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Failed to get archive: ${error}`);
	}

	return { response, containerId };
	// Note: Container is kept alive for reuse. Cache TTL will handle cleanup.
}

/**
 * Read file content from volume
 * Uses cached helper containers for better performance.
 */
export async function readVolumeFile(
	volumeName: string,
	path: string,
	envId?: number | null,
	readOnly: boolean = true
): Promise<string> {
	const containerId = await getOrCreateVolumeHelperContainer(volumeName, envId, readOnly);

	// Sanitize path
	const safePath = path.replace(/[;&|`$(){}[\]<>'"\\]/g, '');
	const fullPath = `${VOLUME_MOUNT_PATH}${safePath.startsWith('/') ? safePath : '/' + safePath}`;

	// Use cat to read file content
	const output = await execInContainer(containerId, ['cat', fullPath], envId);
	return output;
	// Note: Container is kept alive for reuse. Cache TTL will handle cleanup.
}
