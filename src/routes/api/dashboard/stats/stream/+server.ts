import type { RequestHandler } from '@sveltejs/kit';
import {
	getEnvironments,
	getLatestHostMetrics,
	getHostMetrics,
	getContainerEventStats,
	getContainerEvents,
	getEnvSetting,
	getEnvUpdateCheckSettings,
	getPendingContainerUpdates
} from '$lib/server/db';
import {
	listContainers,
	listImages,
	listNetworks,
	getContainerStats,
	getDiskUsage
} from '$lib/server/docker';
import { listComposeStacks } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';
import type { EnvironmentStats } from '../+server';
import { parseLabels } from '$lib/utils/label-colors';

// Skip disk usage collection (Synology NAS performance fix)
const SKIP_DF_COLLECTION = process.env.SKIP_DF_COLLECTION === 'true' || process.env.SKIP_DF_COLLECTION === '1';

// Helper to add timeout to promises
// IMPORTANT: Clears the timeout to prevent memory leaks from accumulated timer closures
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	const timeoutPromise = new Promise<T>((resolve) => {
		timeoutId = setTimeout(() => resolve(fallback), ms);
	});
	return Promise.race([promise, timeoutPromise]).finally(() => {
		if (timeoutId !== null) clearTimeout(timeoutId);
	});
}

// Disk usage cache - getDiskUsage() is very slow (30s timeout) but data changes rarely
// Cache per environment with 5-minute TTL
// DISABLED when SKIP_DF_COLLECTION is set (kills Synology NAS devices)
interface DiskUsageCache {
	data: any;
	timestamp: number;
}
const diskUsageCache: Map<number, DiskUsageCache> = new Map();
const DISK_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 100; // Maximum environments to cache

// Cleanup expired cache entries periodically to prevent unbounded growth
// Also limits cache size for environments that were deleted
setInterval(() => {
	const now = Date.now();
	// Remove expired entries
	for (const [envId, cached] of diskUsageCache.entries()) {
		if (now - cached.timestamp > DISK_CACHE_TTL_MS * 2) {
			diskUsageCache.delete(envId);
		}
	}
	// Enforce max size by removing oldest entries
	if (diskUsageCache.size > MAX_CACHE_SIZE) {
		const entries = Array.from(diskUsageCache.entries())
			.sort((a, b) => a[1].timestamp - b[1].timestamp);
		const toRemove = entries.slice(0, entries.length - MAX_CACHE_SIZE);
		for (const [envId] of toRemove) {
			diskUsageCache.delete(envId);
		}
	}
}, 10 * 60 * 1000); // Every 10 minutes

async function getCachedDiskUsage(envId: number): Promise<any> {
	const cached = diskUsageCache.get(envId);
	const now = Date.now();

	// Return cached data if still valid
	if (cached && (now - cached.timestamp) < DISK_CACHE_TTL_MS) {
		return cached.data;
	}

	// Fetch fresh data with timeout
	const data = await withTimeout(getDiskUsage(envId).catch(() => null), 30000, null);

	// Only cache successful results - if fetch failed, retry on next request
	if (data !== null) {
		diskUsageCache.set(envId, { data, timestamp: now });
	}

	return data;
}

// Limit for per-container stats (reduced from 15 to improve performance)
const TOP_CONTAINERS_LIMIT = 8;

// Calculate CPU percentage from Docker stats (same logic as container stats endpoint)
function calculateCpuPercent(stats: any): number {
	const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
	const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
	const cpuCount = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;

	if (systemDelta > 0 && cpuDelta > 0) {
		return (cpuDelta / systemDelta) * cpuCount * 100;
	}
	return 0;
}

/**
 * Calculate memory usage the same way Docker CLI does.
 * Docker subtracts cache (inactive_file) from total usage to show actual memory consumption.
 * - cgroup v2: subtract inactive_file from stats
 * - cgroup v1: subtract total_inactive_file from stats
 * See: https://docs.docker.com/engine/containers/runmetrics/
 */
function calculateMemoryUsage(memoryStats: any): number {
	const usage = memoryStats?.usage || 0;
	const stats = memoryStats?.stats || {};

	// cgroup v2 uses 'inactive_file', cgroup v1 uses 'total_inactive_file'
	const cache = stats.inactive_file ?? stats.total_inactive_file ?? 0;

	// Only subtract cache if it's less than usage (sanity check)
	if (cache > 0 && cache < usage) {
		return usage - cache;
	}

	return usage;
}

// Progressive stats loading - returns stats object and emits partial updates via callback
async function getEnvironmentStatsProgressive(
	env: any,
	onPartialUpdate: (stats: Partial<EnvironmentStats> & { id: number }) => void
): Promise<EnvironmentStats> {
	const envStats: EnvironmentStats = {
		id: env.id,
		name: env.name,
		host: env.host ?? undefined,
		port: env.port ?? undefined,
		icon: env.icon || 'globe',
		socketPath: env.socketPath ?? undefined,
		collectActivity: env.collectActivity,
		collectMetrics: env.collectMetrics ?? true,
		scannerEnabled: false,
		updateCheckEnabled: false,
		updateCheckAutoUpdate: false,
		labels: parseLabels(env.labels),
		connectionType: (env.connectionType as 'socket' | 'direct' | 'hawser-standard' | 'hawser-edge') || 'socket',
		online: false,
		containers: { total: 0, running: 0, stopped: 0, paused: 0, restarting: 0, unhealthy: 0, pendingUpdates: 0 },
		images: { total: 0, totalSize: 0 },
		volumes: { total: 0, totalSize: 0 },
		containersSize: 0,
		buildCacheSize: 0,
		networks: { total: 0 },
		stacks: { total: 0, running: 0, partial: 0, stopped: 0 },
		metrics: null,
		events: { total: 0, today: 0 },
		topContainers: [],
		recentEvents: [],
		// Loading states for progressive display
		loading: {
			containers: true,
			images: true,
			volumes: true,
			networks: true,
			stacks: true,
			diskUsage: true,
			topContainers: true
		}
	};

	try {
		// Check scanner settings - scanner type is stored in 'vulnerability_scanner'
		const scannerType = await getEnvSetting('vulnerability_scanner', env.id);
		envStats.scannerEnabled = scannerType && scannerType !== 'none';

		// Check update check settings
		const updateCheckSettings = await getEnvUpdateCheckSettings(env.id);
		if (updateCheckSettings && updateCheckSettings.enabled) {
			envStats.updateCheckEnabled = true;
			envStats.updateCheckAutoUpdate = updateCheckSettings.autoUpdate;
		}

		// Get all database stats in parallel for better performance
		// NOTE: We do NOT block on getDockerInfo() here - slow environments would block all others
		// Instead, we determine online status from whether listContainers succeeds
		const [latestMetrics, eventStats, recentEventsResult, metricsHistory, pendingUpdates] = await Promise.all([
			getLatestHostMetrics(env.id),
			getContainerEventStats(env.id),
			getContainerEvents({ environmentId: env.id, limit: 10 }),
			getHostMetrics(30, env.id),
			getPendingContainerUpdates(env.id)
		]);

		if (latestMetrics) {
			envStats.metrics = {
				cpuPercent: latestMetrics.cpuPercent,
				memoryPercent: latestMetrics.memoryPercent,
				memoryUsed: latestMetrics.memoryUsed,
				memoryTotal: latestMetrics.memoryTotal
			};
		}

		envStats.events = {
			total: eventStats.total,
			today: eventStats.today
		};

		envStats.containers.pendingUpdates = pendingUpdates.length;

		if (recentEventsResult.events.length > 0) {
			envStats.recentEvents = recentEventsResult.events.map(e => ({
				container_name: e.containerName || 'unknown',
				action: e.action,
				timestamp: e.timestamp
			}));
		}

		if (metricsHistory.length > 0) {
			envStats.metricsHistory = metricsHistory.reverse().map(m => ({
				cpu_percent: m.cpuPercent,
				memory_percent: m.memoryPercent,
				timestamp: m.timestamp
			}));
		}

		// Send initial update with DB data (online status determined later by Docker API success)
		onPartialUpdate({
			id: env.id,
			metrics: envStats.metrics,
			events: envStats.events,
			recentEvents: envStats.recentEvents,
			metricsHistory: envStats.metricsHistory,
			scannerEnabled: envStats.scannerEnabled,
			updateCheckEnabled: envStats.updateCheckEnabled,
			updateCheckAutoUpdate: envStats.updateCheckAutoUpdate,
			containers: { ...envStats.containers },
			loading: { ...envStats.loading }
		});

		// Helper to get valid size
		const getValidSize = (size: number | undefined | null): number => {
			return size && size > 0 ? size : 0;
		};

		// Track if Docker API is accessible - determined by listContainers success
		let dockerApiAccessible = false;
		let dockerApiError: string | null = null;

		// PHASE 1: Containers (usually fast) - this determines online status
		// Use 10s timeout - this is the critical path that determines if env is online
		const containersPromise = withTimeout(listContainers(true, env.id), 10000, null)
			.then(async (containers) => {
				// Timeout returns null
				if (containers === null) {
					throw new Error('Connection timeout');
				}
				// If we got here, Docker API is accessible
				dockerApiAccessible = true;
				envStats.online = true;

				envStats.containers.total = containers.length;
				envStats.containers.running = containers.filter((c: any) => c.state === 'running').length;
				envStats.containers.stopped = containers.filter((c: any) => c.state === 'exited').length;
				envStats.containers.paused = containers.filter((c: any) => c.state === 'paused').length;
				envStats.containers.restarting = containers.filter((c: any) => c.state === 'restarting').length;
				envStats.containers.unhealthy = containers.filter((c: any) => c.health === 'unhealthy').length;
				// Note: pendingUpdates is already set from DB query, preserve it
				envStats.loading!.containers = false;

				onPartialUpdate({
					id: env.id,
					online: true,
					containers: { ...envStats.containers },
					loading: { ...envStats.loading! }
				});

				return containers;
			})
			.catch((error) => {
				// Docker API failed - mark as offline
				dockerApiAccessible = false;
				const errorStr = String(error);
				if (errorStr.includes('not connected') || errorStr.includes('Edge agent')) {
					dockerApiError = 'Agent not connected';
				} else if (errorStr.includes('FailedToOpenSocket') || errorStr.includes('ECONNREFUSED')) {
					dockerApiError = 'Docker socket not accessible';
				} else if (errorStr.includes('ECONNRESET') || errorStr.includes('connection was closed')) {
					dockerApiError = 'Connection lost';
				} else if (errorStr.includes('timeout') || errorStr.includes('Timeout')) {
					dockerApiError = 'Connection timeout';
				} else {
					dockerApiError = 'Connection error';
				}
				envStats.error = dockerApiError;
				envStats.loading!.containers = false;

				onPartialUpdate({
					id: env.id,
					online: false,
					error: dockerApiError,
					loading: { ...envStats.loading! }
				});

				return [] as any[];
			});

		// PHASE 2: Images, Networks, Stacks (medium speed) - run in parallel
		const imagesPromise = withTimeout(listImages(env.id).catch(() => []), 10000, [])
			.then((images) => {
				envStats.images.total = images.length;
				envStats.images.totalSize = images.reduce((sum: number, img: any) => sum + getValidSize(img.size), 0);
				envStats.loading!.images = false;

				onPartialUpdate({
					id: env.id,
					images: { ...envStats.images },
					loading: { ...envStats.loading! }
				});

				return images;
			})
			.catch(() => {
				envStats.loading!.images = false;
				onPartialUpdate({ id: env.id, loading: { ...envStats.loading! } });
				return [];
			});

		const networksPromise = withTimeout(listNetworks(env.id).catch(() => []), 10000, [])
			.then((networks) => {
				envStats.networks.total = networks.length;
				envStats.loading!.networks = false;

				onPartialUpdate({
					id: env.id,
					networks: { ...envStats.networks },
					loading: { ...envStats.loading! }
				});

				return networks;
			})
			.catch(() => {
				envStats.loading!.networks = false;
				onPartialUpdate({ id: env.id, loading: { ...envStats.loading! } });
				return [];
			});

		const stacksPromise = withTimeout(listComposeStacks(env.id).catch(() => []), 10000, [])
			.then((stacks) => {
				envStats.stacks.total = stacks.length;
				envStats.stacks.running = stacks.filter((s: any) => s.status === 'running').length;
				envStats.stacks.partial = stacks.filter((s: any) => s.status === 'partial').length;
				envStats.stacks.stopped = stacks.filter((s: any) => s.status === 'stopped').length;
				envStats.loading!.stacks = false;

				onPartialUpdate({
					id: env.id,
					stacks: { ...envStats.stacks },
					loading: { ...envStats.loading! }
				});

				return stacks;
			})
			.catch(() => {
				envStats.loading!.stacks = false;
				onPartialUpdate({ id: env.id, loading: { ...envStats.loading! } });
				return [];
			});

		// PHASE 3: Disk usage (slow - includes volumes) - uses cache for better performance
		// Can be disabled with SKIP_DF_COLLECTION env var for Synology NAS
		const diskUsagePromise = SKIP_DF_COLLECTION
			? Promise.resolve(null).then(() => {
				envStats.loading!.volumes = false;
				envStats.loading!.diskUsage = false;
				onPartialUpdate({
					id: env.id,
					volumes: { ...envStats.volumes },
					loading: { ...envStats.loading! }
				});
				return null;
			})
			: getCachedDiskUsage(env.id)
				.then((diskUsage) => {
					if (diskUsage) {
						// Update images with disk usage data (more accurate)
						envStats.images.total = diskUsage.Images?.length || envStats.images.total;
						envStats.images.totalSize = diskUsage.Images?.reduce((sum: number, img: any) => sum + getValidSize(img.Size), 0) || envStats.images.totalSize;

						// Volumes from disk usage
						envStats.volumes.total = diskUsage.Volumes?.length || 0;
						envStats.volumes.totalSize = diskUsage.Volumes?.reduce((sum: number, vol: any) => sum + getValidSize(vol.UsageData?.Size), 0) || 0;

						// Containers disk size
						envStats.containersSize = diskUsage.Containers?.reduce((sum: number, c: any) => sum + getValidSize(c.SizeRw), 0) || 0;

						// Build cache
						envStats.buildCacheSize = diskUsage.BuildCache?.reduce((sum: number, bc: any) => sum + getValidSize(bc.Size), 0) || 0;
					}
					envStats.loading!.volumes = false;
					envStats.loading!.diskUsage = false;

					onPartialUpdate({
						id: env.id,
						images: { ...envStats.images },
						volumes: { ...envStats.volumes },
						containersSize: envStats.containersSize,
						buildCacheSize: envStats.buildCacheSize,
						loading: { ...envStats.loading! }
					});

					return diskUsage;
				})
				.catch(() => {
					envStats.loading!.volumes = false;
					envStats.loading!.diskUsage = false;
					onPartialUpdate({ id: env.id, loading: { ...envStats.loading! } });
					return null;
				});

		// PHASE 4: Top containers (slow - requires per-container stats)
		// Limited to TOP_CONTAINERS_LIMIT containers to reduce API calls
		const topContainersPromise = containersPromise.then(async (containers) => {
			const runningContainersList = containers.filter((c: any) => c.state === 'running');

			const topContainersPromises = runningContainersList.slice(0, TOP_CONTAINERS_LIMIT).map(async (container: any) => {
				try {
					// 5 second timeout per container (increased from 2s for Hawser environments)
					const stats = await withTimeout(
						getContainerStats(container.id, env.id) as Promise<any>,
						5000,
						null
					);
					if (!stats) return null;

					const cpuPercent = calculateCpuPercent(stats);
					const memoryUsage = calculateMemoryUsage(stats.memory_stats);
					const memoryLimit = stats.memory_stats?.limit || 1;
					const memoryPercent = (memoryUsage / memoryLimit) * 100;

					return {
						name: container.name,
						cpuPercent: Math.round(cpuPercent * 100) / 100,
						memoryPercent: Math.round(memoryPercent * 100) / 100
					};
				} catch {
					return null;
				}
			});

			const topContainersResults = await Promise.all(topContainersPromises);
			envStats.topContainers = topContainersResults
				.filter((c): c is { name: string; cpuPercent: number; memoryPercent: number } => c !== null)
				.sort((a, b) => b.cpuPercent - a.cpuPercent)
				.slice(0, 10);
			envStats.loading!.topContainers = false;

			onPartialUpdate({
				id: env.id,
				topContainers: [...envStats.topContainers],
				loading: { ...envStats.loading! }
			});

			return envStats.topContainers;
		}).catch(() => {
			envStats.loading!.topContainers = false;
			onPartialUpdate({ id: env.id, loading: { ...envStats.loading! } });
			return [];
		});

		// Wait for all to complete
		await Promise.allSettled([
			containersPromise,
			imagesPromise,
			networksPromise,
			stacksPromise,
			diskUsagePromise,
			topContainersPromise
		]);

		// Clear loading states when complete
		envStats.loading = undefined;

	} catch (error) {
		// Convert technical error messages to user-friendly ones
		const errorStr = String(error);
		if (errorStr.includes('not connected') || errorStr.includes('Edge agent')) {
			envStats.error = 'Agent not connected';
		} else if (errorStr.includes('FailedToOpenSocket') || errorStr.includes('ECONNREFUSED')) {
			envStats.error = 'Docker socket not accessible';
		} else if (errorStr.includes('ECONNRESET') || errorStr.includes('connection was closed')) {
			envStats.error = 'Connection lost';
		} else if (errorStr.includes('verbose: true') || errorStr.includes('verbose')) {
			envStats.error = 'Connection failed';
		} else if (errorStr.includes('timeout') || errorStr.includes('Timeout')) {
			envStats.error = 'Connection timeout';
		} else {
			// Extract just the error message, not the full stack/details
			const match = errorStr.match(/^(?:Error:\s*)?([^.!?]+[.!?]?)/);
			envStats.error = match ? match[1].trim() : 'Connection error';
		}
		envStats.loading = undefined;
		// Send offline status to client
		onPartialUpdate({
			id: env.id,
			online: false,
			error: envStats.error,
			loading: undefined
		});
	}

	return envStats;
}

export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('environments', 'view')) {
		return new Response(JSON.stringify({ error: 'Permission denied' }), {
			status: 403,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	let environments = await getEnvironments();

	// In enterprise mode, filter environments by user's accessible environments
	if (auth.authEnabled && auth.isEnterprise && auth.isAuthenticated && !auth.isAdmin) {
		const accessibleIds = await auth.getAccessibleEnvironmentIds();
		// accessibleIds is null if user has access to all environments
		if (accessibleIds !== null) {
			environments = environments.filter(env => accessibleIds.includes(env.id));
		}
	}

	// Create a readable stream that sends environment stats progressively
	let controllerClosed = false;
	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();

			// Safe enqueue that checks if controller is still open
			const safeEnqueue = (data: string) => {
				if (!controllerClosed) {
					try {
						controller.enqueue(encoder.encode(data));
					} catch {
						controllerClosed = true;
					}
				}
			};

			// First, send the list of environments so the UI can show skeletons with loading states
			const envList = environments.map(env => ({
				id: env.id,
				name: env.name,
				host: env.host ?? undefined,
				port: env.port ?? undefined,
				icon: env.icon || 'globe',
				socketPath: env.socketPath ?? undefined,
				collectActivity: env.collectActivity,
				collectMetrics: env.collectMetrics ?? true,
				labels: parseLabels(env.labels),
				connectionType: (env.connectionType as 'socket' | 'direct' | 'hawser-standard' | 'hawser-edge') || 'socket',
				// Initial loading state for all sections
				loading: {
					containers: true,
					images: true,
					volumes: true,
					networks: true,
					stacks: true,
					diskUsage: true,
					topContainers: true
				}
			}));
			safeEnqueue(`event: environments\ndata: ${JSON.stringify(envList)}\n\n`);

			// Fetch stats for each environment with progressive updates
			const promises = environments.map(async (env) => {
				try {
					await getEnvironmentStatsProgressive(env, (partialStats) => {
						// Send partial update as it arrives
						safeEnqueue(`event: partial\ndata: ${JSON.stringify(partialStats)}\n\n`);
					});
					// Send final complete stats event for this environment
					safeEnqueue(`event: complete\ndata: ${JSON.stringify({ id: env.id })}\n\n`);
				} catch (error) {
					console.error(`Failed to get stats for ${env.name}:`, error);
					// Convert technical error to user-friendly message
					const errorStr = String(error);
					let friendlyError = 'Connection error';
					if (errorStr.includes('FailedToOpenSocket') || errorStr.includes('ECONNREFUSED')) {
						friendlyError = 'Docker socket not accessible';
					} else if (errorStr.includes('ECONNRESET') || errorStr.includes('connection was closed')) {
						friendlyError = 'Connection lost';
					} else if (errorStr.includes('verbose') || errorStr.includes('typo')) {
						friendlyError = 'Connection failed';
					} else if (errorStr.includes('timeout') || errorStr.includes('Timeout')) {
						friendlyError = 'Connection timeout';
					}
					safeEnqueue(`event: error\ndata: ${JSON.stringify({ id: env.id, error: friendlyError })}\n\n`);
				}
			});

			// Wait for all to complete
			await Promise.allSettled(promises);

			// Send done event and close
			if (!controllerClosed) {
				safeEnqueue(`event: done\ndata: {}\n\n`);
				try {
					controller.close();
				} catch {
					// Already closed
				}
			}
		},
		cancel() {
			// Called when the client disconnects
			controllerClosed = true;
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive'
		}
	});
};
