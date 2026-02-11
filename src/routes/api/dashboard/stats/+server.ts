import { json, type RequestHandler } from '@sveltejs/kit';
import {
	getEnvironments,
	getLatestHostMetrics,
	getContainerEventStats,
	getEnvSetting,
	hasEnvironments,
	getEnvUpdateCheckSettings,
	getPendingContainerUpdates
} from '$lib/server/db';
import {
	listContainers,
	listImages,
	listVolumes,
	listNetworks,
	getDockerInfo,
	getDiskUsage
} from '$lib/server/docker';
import { listComposeStacks } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';
import { parseLabels } from '$lib/utils/label-colors';

// Skip disk usage collection (Synology NAS performance fix)
const SKIP_DF_COLLECTION = process.env.SKIP_DF_COLLECTION === 'true' || process.env.SKIP_DF_COLLECTION === '1';

// Helper to add timeout to promises
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))
	]);
}

// Loading states for progressive tile updates
export interface LoadingStates {
	containers?: boolean;
	images?: boolean;
	volumes?: boolean;
	networks?: boolean;
	stacks?: boolean;
	diskUsage?: boolean;
	topContainers?: boolean;
}

export interface EnvironmentStats {
	id: number;
	name: string;
	host?: string;
	port?: number | null;
	icon: string;
	socketPath?: string;
	collectActivity: boolean;
	collectMetrics: boolean;
	scannerEnabled: boolean;
	updateCheckEnabled: boolean;
	updateCheckAutoUpdate: boolean;
	labels?: string[];
	connectionType: 'socket' | 'direct' | 'hawser-standard' | 'hawser-edge';
	online?: boolean; // undefined = connecting, false = offline, true = online
	error?: string;
	containers: {
		total: number;
		running: number;
		stopped: number;
		paused: number;
		restarting: number;
		unhealthy: number;
		pendingUpdates: number;
	};
	images: {
		total: number;
		totalSize: number;
	};
	volumes: {
		total: number;
		totalSize: number;
	};
	containersSize: number;
	buildCacheSize: number;
	networks: {
		total: number;
	};
	stacks: {
		total: number;
		running: number;
		partial: number;
		stopped: number;
	};
	metrics: {
		cpuPercent: number;
		memoryPercent: number;
		memoryUsed: number;
		memoryTotal: number;
	} | null;
	events: {
		total: number;
		today: number;
	};
	topContainers: Array<{
		id: string;
		name: string;
		cpuPercent: number;
		memoryPercent: number;
	}>;
	metricsHistory?: Array<{
		cpu_percent: number;
		memory_percent: number;
		timestamp: string;
	}>;
	recentEvents?: Array<{
		container_name: string;
		action: string;
		timestamp: string;
	}>;
	// Progressive loading states
	loading?: LoadingStates;
}

export const GET: RequestHandler = async ({ cookies, url }) => {
	const auth = await authorize(cookies);

	// Support single environment query for real-time updates
	const envIdParam = url.searchParams.get('env');
	const envIdNum = envIdParam ? parseInt(envIdParam) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('environments', 'view', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Early return if no environments configured (fresh install)
	if (!await hasEnvironments()) {
		return json([]);
	}

	try {
		let environments = await getEnvironments();

		// Filter to single environment if specified
		if (envIdNum) {
			environments = environments.filter(env => env.id === envIdNum);
			if (environments.length === 0) {
				return json({ error: 'Environment not found' }, { status: 404 });
			}
		}

		// In enterprise mode, filter environments by user's accessible environments
		if (auth.authEnabled && auth.isEnterprise && auth.isAuthenticated && !auth.isAdmin) {
			const accessibleIds = await auth.getAccessibleEnvironmentIds();
			// accessibleIds is null if user has access to all environments
			if (accessibleIds !== null) {
				environments = environments.filter(env => accessibleIds.includes(env.id));
			}
		}

		// Fetch stats for all environments in parallel
		const promises = environments.map(async (env): Promise<EnvironmentStats> => {
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
				topContainers: []
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

				// Check if Docker is accessible (with 5 second timeout)
				const dockerInfo = await withTimeout(getDockerInfo(env.id), 5000, null);
				if (!dockerInfo) {
					envStats.error = 'Connection timeout or Docker not accessible';
					return envStats;
				}
				envStats.online = true;

				// Fetch all data in parallel (with 10 second timeout per operation)
				// Disk usage can be disabled with SKIP_DF_COLLECTION for Synology NAS devices
				const [containers, images, volumes, networks, stacks, diskUsage] = await Promise.all([
					withTimeout(listContainers(true, env.id).catch(() => []), 10000, []),
					withTimeout(listImages(env.id).catch(() => []), 10000, []),
					withTimeout(listVolumes(env.id).catch(() => []), 10000, []),
					withTimeout(listNetworks(env.id).catch(() => []), 10000, []),
					withTimeout(listComposeStacks(env.id).catch(() => []), 10000, []),
					SKIP_DF_COLLECTION ? Promise.resolve(null) : withTimeout(getDiskUsage(env.id).catch(() => null), 10000, null)
				]);

				// Process containers
				envStats.containers.total = containers.length;
				envStats.containers.running = containers.filter((c: any) => c.state === 'running').length;
				envStats.containers.stopped = containers.filter((c: any) => c.state === 'exited').length;
				envStats.containers.paused = containers.filter((c: any) => c.state === 'paused').length;
				envStats.containers.restarting = containers.filter((c: any) => c.state === 'restarting').length;
				envStats.containers.unhealthy = containers.filter((c: any) => c.health === 'unhealthy').length;

				// Helper to get valid size (Docker API returns -1 for uncalculated sizes)
				const getValidSize = (size: number | undefined | null): number => {
					return size && size > 0 ? size : 0;
				};

				// Process disk usage from /system/df for accurate size data
				if (diskUsage) {
					// Images: use Size from /system/df
					envStats.images.total = diskUsage.Images?.length || images.length;
					envStats.images.totalSize = diskUsage.Images?.reduce((sum: number, img: any) => sum + getValidSize(img.Size), 0) || 0;

					// Volumes: use UsageData.Size from /system/df
					envStats.volumes.total = diskUsage.Volumes?.length || volumes.length;
					envStats.volumes.totalSize = diskUsage.Volumes?.reduce((sum: number, vol: any) => sum + getValidSize(vol.UsageData?.Size), 0) || 0;

					// Containers: use SizeRw (writable layer size)
					envStats.containersSize = diskUsage.Containers?.reduce((sum: number, c: any) => sum + getValidSize(c.SizeRw), 0) || 0;

					// Build cache: total size
					envStats.buildCacheSize = diskUsage.BuildCache?.reduce((sum: number, bc: any) => sum + getValidSize(bc.Size), 0) || 0;
				} else {
					// Fallback to original method if /system/df failed
					envStats.images.total = images.length;
					envStats.images.totalSize = images.reduce((sum: number, img: any) => sum + getValidSize(img.size), 0);
					envStats.volumes.total = volumes.length;
					envStats.volumes.totalSize = 0;
				}

				// Process networks
				envStats.networks.total = networks.length;

				// Process stacks
				envStats.stacks.total = stacks.length;
				envStats.stacks.running = stacks.filter((s: any) => s.status === 'running').length;
				envStats.stacks.partial = stacks.filter((s: any) => s.status === 'partial').length;
				envStats.stacks.stopped = stacks.filter((s: any) => s.status === 'stopped').length;

				// Get latest metrics, event stats, and pending updates in parallel
				const [latestMetrics, eventStats, pendingUpdates] = await Promise.all([
					getLatestHostMetrics(env.id),
					getContainerEventStats(env.id),
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

			} catch (error) {
				// Convert technical error messages to user-friendly ones
				const errorStr = String(error);
				if (errorStr.includes('FailedToOpenSocket') || errorStr.includes('ECONNREFUSED')) {
					envStats.error = 'Docker socket not accessible';
				} else if (errorStr.includes('ECONNRESET') || errorStr.includes('connection was closed')) {
					envStats.error = 'Connection lost';
				} else if (errorStr.includes('verbose: true') || errorStr.includes('verbose')) {
					envStats.error = 'Connection failed';
				} else if (errorStr.includes('timeout') || errorStr.includes('Timeout')) {
					envStats.error = 'Connection timeout';
				} else {
					const match = errorStr.match(/^(?:Error:\s*)?([^.!?]+[.!?]?)/);
					envStats.error = match ? match[1].trim() : 'Connection error';
				}
			}

			return envStats;
		});

		const results = await Promise.all(promises);

		// Return single object if single env was requested
		if (envIdParam && results.length === 1) {
			return json(results[0]);
		}

		return json(results);
	} catch (error: any) {
		console.error('Failed to get dashboard stats:', error);
		return json({ error: 'Failed to get dashboard stats' }, { status: 500 });
	}
};
