/**
 * Subprocess Manager
 *
 * Manages a Go collection-worker process that handles background Docker API
 * calls for metrics and event collection. Communication is via JSON lines
 * over stdin (commands) / stdout (results).
 *
 * The Go worker handles: Docker API calls (ping, list, stats, info, df, events)
 * This process handles: DB reads/writes, notifications, SSE broadcast
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { containerEventEmitter } from './event-collector';
import {
	getEnvironments,
	getEnvSetting,
	getMetricsCollectionInterval,
	getEventCollectionMode,
	getEventPollInterval,
	logContainerEvent,
	type ContainerEventAction
} from './db';
import { sendEnvironmentNotification, sendEventNotification } from './notifications';
import { rssBeforeOp, rssAfterOp } from './rss-tracker';
import { pushMetric } from './metrics-store';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GoMessage {
	type: string;
	envId?: number;
	online?: boolean;
	error?: string;
	event?: DockerEvent;
	data?: any;
	info?: any; // Docker /info response (for disk usage percentage)
	cpu?: number;
	memPercent?: number;
	memUsed?: number;
	memTotal?: number;
	cpuCount?: number;
}

interface DockerEvent {
	Type: string;
	Action: string;
	Actor: { ID: string; Attributes: Record<string, string> };
	time: number;
	timeNano: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTAINER_ACTIONS: ContainerEventAction[] = [
	'create', 'start', 'stop', 'die', 'kill', 'restart',
	'pause', 'unpause', 'destroy', 'rename', 'update', 'oom', 'health_status'
];

const SCANNER_IMAGE_PATTERNS = [
	'anchore/grype', 'aquasec/trivy',
	'ghcr.io/anchore/grype', 'ghcr.io/aquasecurity/trivy'
];

const EXCLUDED_CONTAINER_PREFIXES = ['dockhand-browse-'];

const DEDUP_WINDOW_MS = 5000;
const MAX_DEDUP_CACHE_SIZE = 500;
const DISK_WARNING_COOLDOWN = 3600000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let proc: ChildProcess | null = null;
let isShuttingDown = false;
let lineBuffer: Buffer = Buffer.alloc(0);
let restartDelay = 1000;
const MAX_RESTART_DELAY = 60000;

// Ready-signal plumbing: resolved when Go sends {"type":"ready"}
let readyResolve: (() => void) | null = null;
let readyPromise: Promise<void> | null = null;

// Dedup cache for events
const recentEvents: Map<string, number> = new Map();
// Disk warning cooldown per env
const lastDiskWarning: Map<number, number> = new Map();
// Environment name cache (for notifications)
const envNames: Map<number, string> = new Map();
// Track which envIds are currently configured in Go
const configuredEnvs: Set<number> = new Set();

// Dedup cleanup interval
let dedupCleanupInterval: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Go binary path resolution
// ---------------------------------------------------------------------------

function resolveWorkerPath(): string {
	// Dev: pre-built binary in bin/
	const devPath = join(process.cwd(), 'bin', 'collection-worker');
	if (existsSync(devPath)) return devPath;

	// Production: alongside the app
	const prodPath = join(process.cwd(), 'collection-worker');
	if (existsSync(prodPath)) return prodPath;

	// Docker: /app/bin/collection-worker
	const dockerPath = '/app/bin/collection-worker';
	if (existsSync(dockerPath)) return dockerPath;

	throw new Error(`Go collection-worker not found at ${devPath}, ${prodPath}, or ${dockerPath}`);
}

// ---------------------------------------------------------------------------
// IPC: send JSON line to Go process stdin
// ---------------------------------------------------------------------------

function sendToGo(msg: Record<string, unknown>): void {
	if (!proc?.stdin || !proc.stdin.writable) return;
	const line = JSON.stringify(msg) + '\n';
	proc.stdin.write(line);
}

// ---------------------------------------------------------------------------
// IPC: handle JSON line from Go process stdout
// ---------------------------------------------------------------------------

function handleLine(line: string): void {
	if (!line.trim()) return;

	const parseBefore = rssBeforeOp();
	let msg: GoMessage;
	try {
		msg = JSON.parse(line);
	} catch {
		console.error('[SubprocessManager] Invalid JSON from Go worker:', line.substring(0, 200));
		return;
	}
	rssAfterOp('ipc_parse', parseBefore);

	switch (msg.type) {
		case 'ready':
			console.log('[SubprocessManager] Go worker ready');
			restartDelay = 1000; // Reset backoff on successful start
			readyResolve?.();
			readyResolve = null;
			break;

		case 'metrics':
			handleMetrics(msg);
			break;

		case 'env_status':
			handleEnvStatus(msg);
			break;

		case 'container_event':
			handleContainerEvent(msg);
			break;

		case 'disk_usage':
			handleDiskUsage(msg);
			break;

		case 'error':
			if (msg.envId) {
				console.warn(`[SubprocessManager] Go worker error for env ${msg.envId}: ${msg.error}`);
			} else {
				console.error(`[SubprocessManager] Go worker error: ${msg.error}`);
			}
			break;
	}
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

function handleMetrics(msg: GoMessage): void {
	if (!msg.envId || msg.cpu === undefined || msg.memPercent === undefined) return;
	if (!configuredEnvs.has(msg.envId)) return;

	const before = rssBeforeOp();
	pushMetric(msg.envId, msg.cpu, msg.memPercent, msg.memUsed || 0, msg.memTotal || 0);
	rssAfterOp('metrics', before);
}

function handleEnvStatus(msg: GoMessage): void {
	if (!msg.envId || msg.online === undefined) return;

	const before = rssBeforeOp();
	const envName = envNames.get(msg.envId) || `env-${msg.envId}`;

	containerEventEmitter.emit('env_status', {
		envId: msg.envId,
		envName,
		online: msg.online,
		error: msg.error
	});

	// Log status changes
	if (msg.online) {
		console.log(`[SubprocessManager] Environment "${envName}" (${msg.envId}) is now online`);
	} else {
		console.warn(`[SubprocessManager] Environment "${envName}" (${msg.envId}) is offline${msg.error ? `: ${msg.error}` : ''}`);
	}

	// Send notifications for status changes
	if (msg.online) {
		sendEventNotification('environment_online', {
			title: 'Environment online',
			message: `Environment "${envName}" is now reachable`,
			type: 'success'
		}, msg.envId).catch((err) => {
			console.error('[SubprocessManager] Failed to send online notification:', err instanceof Error ? err.message : String(err));
		});
	} else {
		sendEventNotification('environment_offline', {
			title: 'Environment offline',
			message: `Environment "${envName}" is unreachable${msg.error ? `: ${msg.error}` : ''}`,
			type: 'error'
		}, msg.envId).catch((err) => {
			console.error('[SubprocessManager] Failed to send offline notification:', err instanceof Error ? err.message : String(err));
		});
	}
	rssAfterOp('status', before);
}

async function handleContainerEvent(msg: GoMessage): Promise<void> {
	if (!msg.envId || !msg.event) return;
	if (!configuredEnvs.has(msg.envId)) return;

	const before = rssBeforeOp();
	const event = msg.event;
	if (event.Type !== 'container') return;

	const rawAction = event.Action;
	const baseAction = rawAction.split(':')[0] as ContainerEventAction;
	if (!CONTAINER_ACTIONS.includes(baseAction)) return;

	const action = rawAction.startsWith('health_status') ? rawAction : baseAction;
	const containerId = event.Actor?.ID;
	const containerName = event.Actor?.Attributes?.name;
	const image = event.Actor?.Attributes?.image;

	if (!containerId) return;
	if (image && SCANNER_IMAGE_PATTERNS.some(p => image.toLowerCase().includes(p.toLowerCase()))) return;
	if (containerName && EXCLUDED_CONTAINER_PREFIXES.some(prefix => containerName.startsWith(prefix))) return;

	// Dedup
	const dedupKey = `${msg.envId}-${event.timeNano}-${containerId}-${action}`;
	if (recentEvents.has(dedupKey)) return;
	recentEvents.set(dedupKey, Date.now());
	if (recentEvents.size > MAX_DEDUP_CACHE_SIZE) cleanupRecentEvents();

	const timestamp = new Date(Math.floor(event.timeNano / 1000000)).toISOString();

	// Sub-category: DB insert
	const dbBefore = rssBeforeOp();
	try {
		const savedEvent = await logContainerEvent({
			environmentId: msg.envId,
			containerId,
			containerName: containerName || null,
			image: image || null,
			action: action as ContainerEventAction,
			actorAttributes: event.Actor?.Attributes || null,
			timestamp
		});

		containerEventEmitter.emit('event', savedEvent);
	} catch (err) {
		console.error('[SubprocessManager] Failed to save event:', err instanceof Error ? err.message : String(err));
	}
	rssAfterOp('events_db', dbBefore);

	// Sub-category: notification
	const notifBefore = rssBeforeOp();
	const actionLabel = action.startsWith('health_status')
		? action.includes('unhealthy') ? 'Unhealthy' : 'Healthy'
		: action.charAt(0).toUpperCase() + action.slice(1);
	const containerLabel = containerName || containerId.substring(0, 12);
	const notificationType =
		action === 'die' || action === 'kill' || action === 'oom' || action.includes('unhealthy')
			? 'error'
			: action === 'stop'
				? 'warning'
				: action === 'start' || (action.includes('healthy') && !action.includes('unhealthy'))
					? 'success'
					: 'info';

	sendEnvironmentNotification(msg.envId, action, {
		title: `Container ${actionLabel}`,
		message: `Container "${containerLabel}" ${action}${image ? ` (${image})` : ''}`,
		type: notificationType
	}, image).catch(() => {});
	rssAfterOp('events_notif', notifBefore);
	rssAfterOp('events', before);
}

async function handleDiskUsage(msg: GoMessage): Promise<void> {
	if (!msg.envId || !msg.data) return;
	if (!configuredEnvs.has(msg.envId)) return;

	const before = rssBeforeOp();
	const envName = envNames.get(msg.envId) || `env-${msg.envId}`;

	try {
		const diskWarningEnabled = (await getEnvSetting('disk_warning_enabled', msg.envId)) ?? true;
		if (!diskWarningEnabled) return;

		const lastWarning = lastDiskWarning.get(msg.envId);
		if (lastWarning && Date.now() - lastWarning < DISK_WARNING_COOLDOWN) return;

		const diskData = msg.data;
		let totalUsed = 0;
		if (diskData.Images) totalUsed += diskData.Images.reduce((sum: number, img: any) => sum + (img.Size || 0), 0);
		if (diskData.Containers) totalUsed += diskData.Containers.reduce((sum: number, c: any) => sum + (c.SizeRw || 0), 0);
		if (diskData.Volumes) totalUsed += diskData.Volumes.reduce((sum: number, v: any) => sum + (v.UsageData?.Size || 0), 0);
		if (diskData.BuildCache) totalUsed += diskData.BuildCache.reduce((sum: number, bc: any) => sum + (bc.Size || 0), 0);

		const diskWarningMode = (await getEnvSetting('disk_warning_mode', msg.envId)) ?? 'percentage';
		const GB = 1024 * 1024 * 1024;

		if (diskWarningMode === 'absolute') {
			const thresholdGb = (await getEnvSetting('disk_warning_threshold_gb', msg.envId)) ?? 50;
			if (totalUsed > thresholdGb * GB) {
				await sendEventNotification('disk_space_warning', {
					title: 'High Docker disk usage',
					message: `Environment "${envName}" is using ${formatSize(totalUsed)} of Docker disk space (threshold: ${thresholdGb} GB)`,
					type: 'warning'
				}, msg.envId);
				lastDiskWarning.set(msg.envId, Date.now());
			}
		} else {
			// Percentage mode — need DataSpaceTotal from /info DriverStatus
			const driverStatus = msg.info?.DriverStatus;
			let dataSpaceTotal = 0;
			if (Array.isArray(driverStatus)) {
				for (const [key, value] of driverStatus) {
					if (key === 'Data Space Total' && typeof value === 'string') {
						dataSpaceTotal = parseSize(value);
						break;
					}
				}
			}
			if (dataSpaceTotal <= 0) return;

			const diskPercentUsed = (totalUsed / dataSpaceTotal) * 100;
			const threshold = (await getEnvSetting('disk_warning_threshold', msg.envId)) || 80;
			if (diskPercentUsed >= threshold) {
				console.log(`[SubprocessManager] Docker disk usage for ${envName}: ${diskPercentUsed.toFixed(1)}% (threshold: ${threshold}%)`);
				await sendEventNotification('disk_space_warning', {
					title: 'Disk space warning',
					message: `Environment "${envName}" Docker disk usage is at ${diskPercentUsed.toFixed(1)}% (${formatSize(totalUsed)} used)`,
					type: 'warning'
				}, msg.envId);
				lastDiskWarning.set(msg.envId, Date.now());
			}
		}
	} catch (err) {
		console.error(`[SubprocessManager] Failed to process disk usage for env ${msg.envId}:`, err instanceof Error ? err.message : String(err));
	}
	rssAfterOp('disk', before);
}

function parseSize(sizeStr: string): number {
	const units: Record<string, number> = {
		B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4
	};
	const match = sizeStr.match(/^([\d.]+)\s*([KMGT]?B)$/i);
	if (!match) return 0;
	return parseFloat(match[1]) * (units[match[2].toUpperCase()] || 1);
}

function formatSize(bytes: number): string {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let unitIndex = 0;
	let size = bytes;
	while (size >= 1024 && unitIndex < units.length - 1) {
		size /= 1024;
		unitIndex++;
	}
	return `${size.toFixed(1)} ${units[unitIndex]}`;
}

function cleanupRecentEvents(): void {
	const now = Date.now();
	for (const [key, timestamp] of recentEvents.entries()) {
		if (now - timestamp > DEDUP_WINDOW_MS) {
			recentEvents.delete(key);
		}
	}
	if (recentEvents.size > MAX_DEDUP_CACHE_SIZE) {
		const entries = Array.from(recentEvents.entries()).sort((a, b) => a[1] - b[1]);
		const toRemove = entries.slice(0, entries.length - MAX_DEDUP_CACHE_SIZE);
		for (const [key] of toRemove) recentEvents.delete(key);
	}
}

// ---------------------------------------------------------------------------
// Configure environments in Go worker
// ---------------------------------------------------------------------------

async function sendEnvironmentConfigs(): Promise<void> {
	const environments = await getEnvironments();
	const activeIds = new Set<number>();
	const lines: string[] = [];

	const enqueue = (msg: Record<string, unknown>) => {
		lines.push(JSON.stringify(msg));
	};

	for (const env of environments) {
		// Skip hawser-edge (events come via WebSocket)
		if (env.connectionType === 'hawser-edge') continue;

		activeIds.add(env.id);
		envNames.set(env.id, env.name);

		// Build config matching Go's EnvConfig struct
		let config: Record<string, unknown>;

		if (env.connectionType === 'socket' || !env.connectionType) {
			config = {
				type: 'socket',
				socketPath: env.socketPath || '/var/run/docker.sock'
			};
		} else {
			const protocol = (env.protocol as string) || 'http';
			config = {
				type: protocol,
				host: env.host || 'localhost',
				port: env.port || 2375,
				ca: env.tlsCa || undefined,
				cert: env.tlsCert || undefined,
				key: env.tlsKey || undefined,
				skipVerify: !!env.tlsSkipVerify
			};
		}

		// Only send if env has metrics or activity collection enabled
		if (env.collectMetrics === false && env.collectActivity === false) continue;

		enqueue({
			type: 'configure',
			envId: env.id,
			name: env.name,
			config,
			connectionType: env.connectionType || 'socket',
			hawserToken: env.hawserToken || undefined
		});

		configuredEnvs.add(env.id);
	}

	// Remove envs that are no longer active
	for (const envId of configuredEnvs) {
		if (!activeIds.has(envId)) {
			enqueue({ type: 'remove', envId });
			configuredEnvs.delete(envId);
			envNames.delete(envId);
		}
	}

	// Send settings
	const metricsInterval = await getMetricsCollectionInterval();
	enqueue({ type: 'set_metrics_interval', intervalMs: metricsInterval });

	const eventMode = await getEventCollectionMode();
	const pollInterval = await getEventPollInterval();
	enqueue({ type: 'set_event_mode', mode: eventMode, pollIntervalMs: pollInterval });

	// Single atomic write — avoids pipe backpressure on low-memory ARM devices
	// where multiple rapid writes can overflow small OS pipe buffers (4-16KB on
	// some ARM Linux configs) before Go has drained them.
	if (lines.length > 0 && proc?.stdin?.writable) {
		proc.stdin.write(lines.join('\n') + '\n');
	}
}

// ---------------------------------------------------------------------------
// Process stdout reader (Node.js streams)
// ---------------------------------------------------------------------------

function readStdout(): void {
	if (!proc?.stdout) return;

	proc.stdout.on('data', (chunk: Buffer) => {
		const readBefore = rssBeforeOp();

		// Append chunk to buffer without string conversion
		lineBuffer = lineBuffer.length === 0 ? chunk : Buffer.concat([lineBuffer, chunk]);

		// Extract complete lines (delimited by \n)
		let start = 0;
		for (let i = 0; i < lineBuffer.length; i++) {
			if (lineBuffer[i] === 0x0a) { // newline
				if (i > start) {
					const line = lineBuffer.toString('utf8', start, i);
					handleLine(line);
				}
				start = i + 1;
			}
		}

		// Keep leftover bytes (incomplete line).
		// Buffer.from() copies the data to a new allocation, releasing the
		// parent ArrayBuffer. Using subarray() would retain the entire chunk.
		if (start === lineBuffer.length) {
			lineBuffer = Buffer.alloc(0);
		} else if (start > 0) {
			lineBuffer = Buffer.from(lineBuffer.subarray(start));
		}
		rssAfterOp('ipc_read', readBefore);
	});

	proc.stdout.on('error', (err) => {
		if (!isShuttingDown) {
			console.error('[SubprocessManager] stdout read error:', err.message);
		}
	});
}

// ---------------------------------------------------------------------------
// Public API (unchanged interface)
// ---------------------------------------------------------------------------

/**
 * Start background Go collection worker.
 */
export async function startSubprocesses(): Promise<void> {
	if (isShuttingDown) return;

	if (process.env.DISABLE_METRICS === 'true' && process.env.DISABLE_EVENTS === 'true') {
		console.log('[SubprocessManager] Metrics and events both disabled, skipping worker');
		return;
	}

	const workerPath = resolveWorkerPath();
	console.log(`[SubprocessManager] Starting Go worker (${workerPath})...`);

	// Set up ready promise BEFORE spawning so we don't miss the signal
	readyPromise = new Promise<void>(resolve => { readyResolve = resolve; });

	proc = spawn(workerPath, [], {
		stdio: ['pipe', 'pipe', 'inherit']
	});

	// Prevent unhandled 'error' events on stdin from destroying the pipe.
	// Without this, any write error (e.g. EPIPE on a momentarily full pipe buffer
	// on low-memory systems) destroys the stream, sending EOF to Go and causing
	// it to exit — which looks like a mysterious restart loop on Raspberry Pi.
	proc.stdin?.on('error', (err: NodeJS.ErrnoException) => {
		if (!isShuttingDown) {
			console.error('[SubprocessManager] stdin pipe error:', err.message);
		}
	});

	// Start reading stdout
	readStdout();

	// Handle process exit
	proc.on('exit', (code) => {
		// Clear stale ready promise if process exits before signalling ready
		readyResolve = null;
		readyPromise = null;

		if (!isShuttingDown) {
			console.warn(`[SubprocessManager] Go worker exited with code ${code}, restarting in ${restartDelay / 1000}s...`);
			proc = null;
			configuredEnvs.clear();
			setTimeout(() => startSubprocesses(), restartDelay);
			restartDelay = Math.min(restartDelay * 2, MAX_RESTART_DELAY);
		}
	});

	proc.on('error', (err) => {
		console.error('[SubprocessManager] Failed to start Go worker:', err.message);
		proc = null;
	});

	// Wait for Go to signal it's ready and reading stdin, then send configs.
	// This fixes a race on DietPi where stdin closes transiently before the
	// old blind 100ms wait ends, causing configure messages to be silently dropped.
	try {
		await Promise.race([
			readyPromise,
			new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
		]);
	} catch {
		console.warn('[SubprocessManager] Go worker ready timeout, sending configs anyway');
	}
	readyPromise = null;
	await sendEnvironmentConfigs();

	// Start dedup cleanup interval
	if (!dedupCleanupInterval) {
		dedupCleanupInterval = setInterval(cleanupRecentEvents, 5000);
	}
}

/**
 * Stop the background Go collection worker.
 */
export async function stopSubprocesses(): Promise<void> {
	isShuttingDown = true;

	if (dedupCleanupInterval) {
		clearInterval(dedupCleanupInterval);
		dedupCleanupInterval = null;
	}

	if (proc) {
		sendToGo({ type: 'shutdown' });

		// Wait up to 2s for clean exit, then kill
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				if (proc) {
					proc.kill();
					proc = null;
				}
				resolve();
			}, 2000);

			proc!.on('exit', () => {
				clearTimeout(timeout);
				proc = null;
				resolve();
			});
		});
	}

	recentEvents.clear();
	lastDiskWarning.clear();
	configuredEnvs.clear();
}

/**
 * Signal the worker to refresh its environment/event configuration.
 */
export function refreshSubprocessEnvironments(): void {
	sendEnvironmentConfigs().catch(err => {
		console.error('[SubprocessManager] Failed to refresh configs:', err instanceof Error ? err.message : String(err));
	});
}

/**
 * Send a command to the metrics worker (update_interval).
 */
export function sendToMetricsSubprocess(message: { type: string; intervalMs?: number }): void {
	if (message.type === 'update_interval' && message.intervalMs) {
		sendToGo({ type: 'set_metrics_interval', intervalMs: message.intervalMs });
	}
}

/**
 * Send a command to the event worker (refresh_environments).
 */
export function sendToEventSubprocess(message: { type: string }): void {
	if (message.type === 'refresh_environments') {
		refreshSubprocessEnvironments();
	}
}
