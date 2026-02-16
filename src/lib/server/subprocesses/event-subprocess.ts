/**
 * Event Collection Subprocess
 *
 * Runs as a separate process via Bun.spawn to collect Docker container events
 * without blocking the main HTTP thread.
 *
 * Communication with main process via IPC (process.send).
 */

import { getEnvironments, getEventCollectionMode, getEventPollInterval, type ContainerEventAction } from '../db';
import { getDockerEvents } from '../docker';
import type { MainProcessCommand } from '../subprocess-manager';

// Reconnection settings
const RECONNECT_DELAY = 5000; // 5 seconds
const MAX_RECONNECT_DELAY = 60000; // 1 minute max

// Track environment online status for notifications
// Only send notifications on status CHANGES, not on every reconnect attempt
const environmentOnlineStatus: Map<number, boolean> = new Map();

// Active collectors per environment (for streaming mode)
const collectors: Map<number, { controller: AbortController; reconnectTimeout: ReturnType<typeof setTimeout> | null }> = new Map();

// Poll intervals per environment (for polling mode)
const pollIntervals: Map<number, ReturnType<typeof setInterval>> = new Map();

// Last poll timestamp per environment (for polling mode)
const lastPollTime: Map<number, number> = new Map();

// Recent event cache for deduplication (key: timeNano-containerId-action)
const recentEvents: Map<string, number> = new Map();
const DEDUP_WINDOW_MS = 5000; // 5 second window for deduplication
const CACHE_CLEANUP_INTERVAL_MS = 5000; // Clean up cache every 5 seconds (match dedup window)
const MAX_DEDUP_CACHE_SIZE = 500; // Hard limit to prevent unbounded growth

let cacheCleanupInterval: ReturnType<typeof setInterval> | null = null;
let isShuttingDown = false;

// Track current settings to detect changes
let currentPollInterval: number = 60000;
let currentMode: 'stream' | 'poll' = 'stream';

// Actions we care about for container activity
const CONTAINER_ACTIONS: ContainerEventAction[] = [
	'create',
	'start',
	'stop',
	'die',
	'kill',
	'restart',
	'pause',
	'unpause',
	'destroy',
	'rename',
	'update',
	'oom',
	'health_status'
];

// Scanner image patterns to exclude from events
const SCANNER_IMAGE_PATTERNS = [
	'anchore/grype',
	'aquasec/trivy',
	'ghcr.io/anchore/grype',
	'ghcr.io/aquasecurity/trivy'
];

// Container name patterns to exclude from events
const EXCLUDED_CONTAINER_PREFIXES = ['dockhand-browse-'];

/**
 * Send message to main process
 */
function send(message: any): void {
	if (process.send) {
		process.send(message);
	}
}

function isScannerContainer(image: string | null | undefined): boolean {
	if (!image) return false;
	const lowerImage = image.toLowerCase();
	return SCANNER_IMAGE_PATTERNS.some((pattern) => lowerImage.includes(pattern.toLowerCase()));
}

function isExcludedContainer(containerName: string | null | undefined): boolean {
	if (!containerName) return false;
	return EXCLUDED_CONTAINER_PREFIXES.some((prefix) => containerName.startsWith(prefix));
}

/**
 * Update environment online status and notify main process on change
 */
function updateEnvironmentStatus(
	envId: number,
	envName: string,
	isOnline: boolean,
	errorMessage?: string
) {
	const previousStatus = environmentOnlineStatus.get(envId);

	// Only send notification on status CHANGE (not on first connection or repeated failures)
	if (previousStatus !== undefined && previousStatus !== isOnline) {
		send({
			type: 'env_status',
			envId,
			envName,
			online: isOnline,
			error: errorMessage
		});
	}

	environmentOnlineStatus.set(envId, isOnline);
}

interface DockerEvent {
	Type: string;
	Action: string;
	Actor: {
		ID: string;
		Attributes: Record<string, string>;
	};
	time: number;
	timeNano: number;
}

/**
 * Clean up old entries from the deduplication cache
 * Also enforces max size limit with LRU eviction
 */
function cleanupRecentEvents() {
	const now = Date.now();
	// First pass: remove expired entries
	for (const [key, timestamp] of recentEvents.entries()) {
		if (now - timestamp > DEDUP_WINDOW_MS) {
			recentEvents.delete(key);
		}
	}
	// Second pass: enforce max size with LRU eviction if still too large
	if (recentEvents.size > MAX_DEDUP_CACHE_SIZE) {
		const entries = Array.from(recentEvents.entries())
			.sort((a, b) => a[1] - b[1]); // Sort by timestamp (oldest first)
		const toRemove = entries.slice(0, entries.length - MAX_DEDUP_CACHE_SIZE);
		for (const [key] of toRemove) {
			recentEvents.delete(key);
		}
	}
}

/**
 * Process a Docker event
 */
function processEvent(event: DockerEvent, envId: number) {
	// Only process container events
	if (event.Type !== 'container') return;

	// Map Docker action to our action type
	// For health_status events, Docker sends "health_status: unhealthy" or "health_status: healthy"
	// We need to preserve the full string for notifications to distinguish healthy vs unhealthy
	const rawAction = event.Action;
	const baseAction = rawAction.split(':')[0] as ContainerEventAction;

	// Skip actions we don't care about
	if (!CONTAINER_ACTIONS.includes(baseAction)) return;

	// For notifications, preserve full action for health_status to enable proper mapping
	const action = rawAction.startsWith('health_status') ? rawAction : baseAction;

	const containerId = event.Actor?.ID;
	const containerName = event.Actor?.Attributes?.name;
	const image = event.Actor?.Attributes?.image;

	if (!containerId) return;

	// Skip scanner containers (Trivy, Grype)
	if (isScannerContainer(image)) return;

	// Skip internal Dockhand containers (volume browser helpers)
	if (isExcludedContainer(containerName)) return;

	// Deduplicate events
	const dedupKey = `${envId}-${event.timeNano}-${containerId}-${action}`;
	if (recentEvents.has(dedupKey)) {
		return;
	}

	// Mark as processed
	recentEvents.set(dedupKey, Date.now());

	// Clean up if cache gets too large
	if (recentEvents.size > 200) {
		cleanupRecentEvents();
	}

	// Convert Unix nanosecond timestamp to ISO string
	const timestamp = new Date(Math.floor(event.timeNano / 1000000)).toISOString();

	// Prepare notification data
	// For health_status events, create a cleaner label
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

	// Send event to main process for DB save and SSE broadcast
	send({
		type: 'container_event',
		event: {
			environmentId: envId,
			containerId: containerId,
			containerName: containerName || null,
			image: image || null,
			action,
			actorAttributes: event.Actor?.Attributes || null,
			timestamp
		},
		notification: {
			action,
			title: `Container ${actionLabel}`,
			message: `Container "${containerLabel}" ${action}${image ? ` (${image})` : ''}`,
			notificationType,
			image
		}
	});
}

/**
 * Poll events for a specific environment (polling mode)
 */
async function pollEnvironmentEvents(envId: number, envName: string) {
	try {
		// Calculate 'since' timestamp (use last poll time, or start from 30s ago if first poll)
		const now = Math.floor(Date.now() / 1000); // Unix timestamp in seconds
		const since = lastPollTime.get(envId) || (now - 30); // Default to 30s ago on first poll

		// Fetch events since last check until now
		// IMPORTANT: 'until' is required for polling mode, otherwise Docker keeps the connection open
		const eventStream = await getDockerEvents(
			{ type: ['container'] },
			envId,
			{ since: since.toString(), until: now.toString() }
		);

		if (!eventStream) {
			console.error(`[EventSubprocess] Failed to fetch events for ${envName}`);
			updateEnvironmentStatus(envId, envName, false, 'Failed to fetch Docker events');
			return;
		}

		// Mark environment as online
		updateEnvironmentStatus(envId, envName, true);

		// Read and process all events
		const reader = eventStream.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (line.trim()) {
						try {
							const event = JSON.parse(line) as DockerEvent;
							processEvent(event, envId);
						} catch {
							// Ignore parse errors
						}
					}
				}
			}
		} finally {
			try {
				// Cancel the stream first to ensure proper cleanup, then release lock
				await reader.cancel();
				reader.releaseLock();
			} catch {
				// Reader already released or stream closed
			}
		}

		// Update last poll time
		lastPollTime.set(envId, now);

	} catch (error: any) {
		if (!isShuttingDown) {
			console.error(`[EventSubprocess] Poll error for ${envName}:`, error.message);
			updateEnvironmentStatus(envId, envName, false, error.message);
		}
	}
}

/**
 * Start collecting events for a specific environment
 */
async function startEnvironmentCollector(envId: number, envName: string) {
	// Stop existing collector if any
	stopEnvironmentCollector(envId);

	const controller = new AbortController();
	const entry = { controller, reconnectTimeout: null as ReturnType<typeof setTimeout> | null };
	collectors.set(envId, entry);

	let reconnectDelay = RECONNECT_DELAY;

	const connect = async () => {
		if (controller.signal.aborted || isShuttingDown) return;

		let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

		try {
			console.log(
				`[EventSubprocess] Connecting to Docker events for ${envName} (env ${envId})...`
			);

			const eventStream = await getDockerEvents({ type: ['container'] }, envId);

			if (!eventStream) {
				console.error(`[EventSubprocess] Failed to get event stream for ${envName}`);
				updateEnvironmentStatus(envId, envName, false, 'Failed to connect to Docker');
				scheduleReconnect();
				return;
			}

			// Reset reconnect delay on successful connection
			reconnectDelay = RECONNECT_DELAY;
			console.log(`[EventSubprocess] Connected to Docker events for ${envName}`);

			updateEnvironmentStatus(envId, envName, true);

			reader = eventStream.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			try {
				while (!controller.signal.aborted && !isShuttingDown) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split('\n');
					buffer = lines.pop() || '';

					for (const line of lines) {
						if (line.trim()) {
							try {
								const event = JSON.parse(line) as DockerEvent;
								processEvent(event, envId);
							} catch {
								// Ignore parse errors for partial chunks
							}
						}
					}
				}
			} catch (error: any) {
				if (!controller.signal.aborted && !isShuttingDown) {
					if (error.name !== 'AbortError') {
						console.error(`[EventSubprocess] Stream error for ${envName}:`, error.message);
						updateEnvironmentStatus(envId, envName, false, error.message);
					}
				}
			} finally {
				if (reader) {
					try {
						// Cancel the stream first to ensure proper cleanup, then release lock
						await reader.cancel();
						reader.releaseLock();
					} catch {
						// Reader already released or stream closed - ignore
					}
				}
			}

			// Connection closed, reconnect
			if (!controller.signal.aborted && !isShuttingDown) {
				scheduleReconnect();
			}
		} catch (error: any) {
			if (reader) {
				try {
					// Cancel the stream first to ensure proper cleanup, then release lock
					await reader.cancel();
					reader.releaseLock();
				} catch {
					// Reader already released or stream closed - ignore
				}
			}

			if (!controller.signal.aborted && !isShuttingDown && error.name !== 'AbortError') {
				console.error(`[EventSubprocess] Connection error for ${envName}:`, error.message);
				updateEnvironmentStatus(envId, envName, false, error.message);
			}

			if (!controller.signal.aborted && !isShuttingDown) {
				scheduleReconnect();
			}
		}
	};

	const scheduleReconnect = () => {
		if (controller.signal.aborted || isShuttingDown) return;

		console.log(`[EventSubprocess] Reconnecting to ${envName} in ${reconnectDelay / 1000}s...`);
		entry.reconnectTimeout = setTimeout(() => {
			entry.reconnectTimeout = null;
			if (!controller.signal.aborted && !isShuttingDown) {
				connect();
			}
		}, reconnectDelay);

		// Exponential backoff
		reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
	};

	// Start the connection
	connect();
}

/**
 * Start polling mode for a specific environment
 */
async function startEnvironmentPoller(envId: number, envName: string, interval: number) {
	// Stop existing poller if any
	stopEnvironmentPoller(envId);

	console.log(`[EventSubprocess] Starting poller for ${envName} (every ${interval / 1000}s)`);

	// Initial poll immediately
	await pollEnvironmentEvents(envId, envName);

	// Set up interval for subsequent polls
	const intervalId = setInterval(async () => {
		if (!isShuttingDown) {
			await pollEnvironmentEvents(envId, envName);
		}
	}, interval);

	pollIntervals.set(envId, intervalId);
}

/**
 * Stop polling for a specific environment
 */
function stopEnvironmentPoller(envId: number) {
	const intervalId = pollIntervals.get(envId);
	if (intervalId) {
		clearInterval(intervalId);
		pollIntervals.delete(envId);
		lastPollTime.delete(envId);
		environmentOnlineStatus.delete(envId);
	}
}

/**
 * Stop collecting events for a specific environment (streaming mode)
 */
function stopEnvironmentCollector(envId: number) {
	const entry = collectors.get(envId);
	if (entry) {
		if (entry.reconnectTimeout !== null) {
			clearTimeout(entry.reconnectTimeout);
		}
		entry.controller.abort();
		collectors.delete(envId);
		environmentOnlineStatus.delete(envId);
	}
}

/**
 * Refresh collectors when environments change
 */
async function refreshEventCollectors() {
	if (isShuttingDown) return;

	try {
		const environments = await getEnvironments();
		const mode = await getEventCollectionMode();
		const pollInterval = await getEventPollInterval();

		// Detect if settings changed
		const modeChanged = mode !== currentMode;
		const intervalChanged = pollInterval !== currentPollInterval;

		if (modeChanged) {
			console.log(`[EventSubprocess] Mode changed from ${currentMode} to ${mode}`);
			currentMode = mode;
		}
		if (intervalChanged) {
			console.log(`[EventSubprocess] Poll interval changed from ${currentPollInterval}ms to ${pollInterval}ms`);
			currentPollInterval = pollInterval;
		}

		// Filter: only collect for environments with activity enabled AND not Hawser Edge
		const activeEnvIds = new Set(
			environments
				.filter((e) => e.collectActivity && e.connectionType !== 'hawser-edge')
				.map((e) => e.id)
		);

		// Stop collectors for removed environments or those with collection disabled
		for (const envId of collectors.keys()) {
			if (!activeEnvIds.has(envId)) {
				console.log(`[EventSubprocess] Stopping stream collector for environment ${envId}`);
				stopEnvironmentCollector(envId);
			}
		}

		// Stop pollers for removed environments or those with collection disabled
		// Also restart all pollers if interval changed
		for (const envId of pollIntervals.keys()) {
			if (!activeEnvIds.has(envId)) {
				console.log(`[EventSubprocess] Stopping poller for environment ${envId}`);
				stopEnvironmentPoller(envId);
			} else if (intervalChanged && mode === 'poll') {
				// Restart poller with new interval
				console.log(`[EventSubprocess] Restarting poller for environment ${envId} with new interval`);
				stopEnvironmentPoller(envId);
			}
		}

		// Clean up stale map entries for deleted environments
		const allEnvIds = new Set(environments.map((e) => e.id));
		for (const envId of environmentOnlineStatus.keys()) {
			if (!allEnvIds.has(envId)) environmentOnlineStatus.delete(envId);
		}
		for (const envId of lastPollTime.keys()) {
			if (!allEnvIds.has(envId)) lastPollTime.delete(envId);
		}

		// Start collectors based on mode
		for (const env of environments) {
			// Skip Hawser Edge (handled by main process)
			if (env.connectionType === 'hawser-edge') continue;

			// Skip if activity collection is disabled
			if (!env.collectActivity) continue;

			const hasStreamCollector = collectors.has(env.id);
			const hasPoller = pollIntervals.has(env.id);

			if (mode === 'stream') {
				// Switch from polling to streaming if needed
				if (hasPoller) {
					console.log(`[EventSubprocess] Switching ${env.name} from poll to stream`);
					stopEnvironmentPoller(env.id);
				}
				// Start stream if not already running
				if (!hasStreamCollector) {
					startEnvironmentCollector(env.id, env.name);
				}
			} else if (mode === 'poll') {
				// Switch from streaming to polling if needed
				if (hasStreamCollector) {
					console.log(`[EventSubprocess] Switching ${env.name} from stream to poll`);
					stopEnvironmentCollector(env.id);
				}
				// Start poller if not already running (will also restart after interval change above)
				if (!hasPoller) {
					startEnvironmentPoller(env.id, env.name, pollInterval);
				}
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[EventSubprocess] Failed to refresh collectors: ${message}`);
		send({ type: 'error', message: `Failed to refresh collectors: ${message}` });
	}
}

/**
 * Handle commands from main process
 */
function handleCommand(command: MainProcessCommand): void {
	switch (command.type) {
		case 'refresh_environments':
			console.log('[EventSubprocess] Refreshing environments...');
			refreshEventCollectors();
			break;

		case 'update_interval':
			// This is used by metrics subprocess, but we handle it here too for consistency
			// Event subprocess re-reads interval from DB on refresh
			console.log('[EventSubprocess] Interval update - refreshing collectors...');
			refreshEventCollectors();
			break;

		case 'shutdown':
			console.log('[EventSubprocess] Shutdown requested');
			shutdown();
			break;
	}
}

/**
 * Graceful shutdown
 */
function shutdown(): void {
	isShuttingDown = true;

	// Stop periodic cache cleanup
	if (cacheCleanupInterval) {
		clearInterval(cacheCleanupInterval);
		cacheCleanupInterval = null;
	}

	// Stop all environment stream collectors
	for (const envId of collectors.keys()) {
		stopEnvironmentCollector(envId);
	}

	// Stop all environment pollers
	for (const envId of pollIntervals.keys()) {
		stopEnvironmentPoller(envId);
	}

	// Clear the deduplication cache
	recentEvents.clear();

	console.log('[EventSubprocess] Stopped');
	process.exit(0);
}

/**
 * Start the event collector
 */
async function start(): Promise<void> {
	console.log('[EventSubprocess] Starting container event collection...');

	// Initialize current settings from database
	try {
		currentMode = await getEventCollectionMode();
		currentPollInterval = await getEventPollInterval();
		console.log(`[EventSubprocess] Initial mode: ${currentMode}, poll interval: ${currentPollInterval}ms`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[EventSubprocess] Failed to load settings, using defaults: ${message}`);
	}

	// Start collectors for all environments
	await refreshEventCollectors();

	// Start periodic cache cleanup
	cacheCleanupInterval = setInterval(cleanupRecentEvents, CACHE_CLEANUP_INTERVAL_MS);
	console.log('[EventSubprocess] Started deduplication cache cleanup (every 5s)');

	// Start memory diagnostics logging (every 5 minutes)
	setInterval(() => {
		const mem = process.memoryUsage();
		console.log(
			`[EventSubprocess] Memory: heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB, ` +
			`rss=${Math.round(mem.rss / 1024 / 1024)}MB, ` +
			`dedup=${recentEvents.size}, collectors=${collectors.size}, pollers=${pollIntervals.size}`
		);
	}, 5 * 60 * 1000);

	// Listen for commands from main process
	process.on('message', (message: MainProcessCommand) => {
		handleCommand(message);
	});

	// Handle termination signals
	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);

	// Signal ready
	send({ type: 'ready' });

	console.log('[EventSubprocess] Started successfully');
}

// Start the subprocess
start();
