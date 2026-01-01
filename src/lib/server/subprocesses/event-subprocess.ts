/**
 * Event Collection Subprocess
 *
 * Runs as a separate process via Bun.spawn to collect Docker container events
 * without blocking the main HTTP thread.
 *
 * Communication with main process via IPC (process.send).
 */

import { getEnvironments, type ContainerEventAction } from '../db';
import { getDockerEvents } from '../docker';
import type { MainProcessCommand } from '../subprocess-manager';

// Reconnection settings
const RECONNECT_DELAY = 5000; // 5 seconds
const MAX_RECONNECT_DELAY = 60000; // 1 minute max

// Track environment online status for notifications
// Only send notifications on status CHANGES, not on every reconnect attempt
const environmentOnlineStatus: Map<number, boolean> = new Map();

// Active collectors per environment
const collectors: Map<number, AbortController> = new Map();

// Recent event cache for deduplication (key: timeNano-containerId-action)
const recentEvents: Map<string, number> = new Map();
const DEDUP_WINDOW_MS = 5000; // 5 second window for deduplication
const CACHE_CLEANUP_INTERVAL_MS = 30000; // Clean up cache every 30 seconds

let cacheCleanupInterval: ReturnType<typeof setInterval> | null = null;
let isShuttingDown = false;

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
 */
function cleanupRecentEvents() {
	const now = Date.now();
	for (const [key, timestamp] of recentEvents.entries()) {
		if (now - timestamp > DEDUP_WINDOW_MS) {
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
 * Start collecting events for a specific environment
 */
async function startEnvironmentCollector(envId: number, envName: string) {
	// Stop existing collector if any
	stopEnvironmentCollector(envId);

	const controller = new AbortController();
	collectors.set(envId, controller);

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
		setTimeout(() => {
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
 * Stop collecting events for a specific environment
 */
function stopEnvironmentCollector(envId: number) {
	const controller = collectors.get(envId);
	if (controller) {
		controller.abort();
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

		// Filter: only collect for environments with activity enabled AND not Hawser Edge
		const activeEnvIds = new Set(
			environments
				.filter((e) => e.collectActivity && e.connectionType !== 'hawser-edge')
				.map((e) => e.id)
		);

		// Stop collectors for removed environments or those with collection disabled
		for (const envId of collectors.keys()) {
			if (!activeEnvIds.has(envId)) {
				console.log(`[EventSubprocess] Stopping collector for environment ${envId}`);
				stopEnvironmentCollector(envId);
			}
		}

		// Start collectors for environments with collection enabled
		for (const env of environments) {
			// Skip Hawser Edge (handled by main process)
			if (env.connectionType === 'hawser-edge') continue;

			if (env.collectActivity && !collectors.has(env.id)) {
				startEnvironmentCollector(env.id, env.name);
			}
		}
	} catch (error) {
		console.error('[EventSubprocess] Failed to refresh collectors:', error);
		send({ type: 'error', message: `Failed to refresh collectors: ${error}` });
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

	// Stop all environment collectors
	for (const envId of collectors.keys()) {
		stopEnvironmentCollector(envId);
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

	// Start collectors for all environments
	await refreshEventCollectors();

	// Start periodic cache cleanup
	cacheCleanupInterval = setInterval(cleanupRecentEvents, CACHE_CLEANUP_INTERVAL_MS);
	console.log('[EventSubprocess] Started deduplication cache cleanup (every 30s)');

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
