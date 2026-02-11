import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listContainers, getContainerStats, EnvironmentNotFoundError } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { hasEnvironments } from '$lib/server/db';
import type { ContainerStats } from '$lib/types';

function calculateCpuPercent(stats: any): number {
	const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
	const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
	const cpuCount = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;

	if (systemDelta > 0 && cpuDelta > 0) {
		return (cpuDelta / systemDelta) * cpuCount * 100;
	}
	return 0;
}

function calculateNetworkIO(stats: any): { rx: number; tx: number } {
	let rx = 0;
	let tx = 0;

	if (stats.networks) {
		for (const iface of Object.values(stats.networks) as any[]) {
			rx += iface.rx_bytes || 0;
			tx += iface.tx_bytes || 0;
		}
	}

	return { rx, tx };
}

function calculateBlockIO(stats: any): { read: number; write: number } {
	let read = 0;
	let write = 0;

	const ioStats = stats.blkio_stats?.io_service_bytes_recursive;
	if (Array.isArray(ioStats)) {
		for (const entry of ioStats) {
			if (entry.op === 'read' || entry.op === 'Read') {
				read += entry.value || 0;
			} else if (entry.op === 'write' || entry.op === 'Write') {
				write += entry.value || 0;
			}
		}
	}

	return { read, write };
}

/**
 * Calculate memory usage the same way Docker CLI does.
 * Docker subtracts cache (inactive_file) from total usage to show actual memory consumption.
 * - cgroup v2: subtract inactive_file from stats
 * - cgroup v1: subtract total_inactive_file from stats
 * See: https://docs.docker.com/engine/containers/runmetrics/
 *
 * Returns: { usage: actual memory (minus cache), raw: total usage, cache: file cache }
 */
function calculateMemoryUsage(memoryStats: any): { usage: number; raw: number; cache: number } {
	const raw = memoryStats?.usage || 0;
	const stats = memoryStats?.stats || {};

	// cgroup v2 uses 'inactive_file', cgroup v1 uses 'total_inactive_file'
	const cache = stats.inactive_file ?? stats.total_inactive_file ?? 0;

	// Only subtract cache if it's less than raw usage (sanity check)
	const usage = (cache > 0 && cache < raw) ? raw - cache : raw;

	return { usage, raw, cache };
}

// Helper to add timeout to promises
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))
	]);
}

export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;
	const debugContainer = url.searchParams.get('debug'); // Get raw stats for specific container

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('containers', 'view', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Early return if no environments configured (fresh install)
	if (!await hasEnvironments()) {
		return json([]);
	}

	// Early return if no environment specified
	if (!envIdNum) {
		return json([]);
	}

	try {
		// Get all running containers with timeout
		const containers = await withTimeout(
			listContainers(true, envIdNum),
			5000, // 5 second timeout
			[]
		);
		const runningContainers = containers.filter(c => c.state === 'running');

		// Debug mode: return raw stats for specific container
		if (debugContainer) {
			const container = runningContainers.find(c => c.name === debugContainer);
			if (container) {
				const rawStats = await getContainerStats(container.id, envIdNum);
				return json({
					name: container.name,
					memory_stats: (rawStats as any).memory_stats
				});
			}
			return json({ error: 'Container not found' }, { status: 404 });
		}

		// Get stats for each running container (in parallel with timeout)
		const statsPromises = runningContainers.map(async (container) => {
			try {
				const stats = await withTimeout(
					getContainerStats(container.id, envIdNum) as Promise<any>,
					3000, // 3 second timeout per container
					null
				);

				if (!stats) return null;

				const cpuPercent = calculateCpuPercent(stats);
				// Calculate memory usage the same way Docker CLI does (excludes cache)
				const memory = calculateMemoryUsage(stats.memory_stats);
				const memoryLimit = stats.memory_stats?.limit || 1;
				const memoryPercent = (memory.usage / memoryLimit) * 100;
				const networkIO = calculateNetworkIO(stats);
				const blockIO = calculateBlockIO(stats);

				return {
					id: container.id,
					name: container.name,
					cpuPercent: Math.round(cpuPercent * 100) / 100,
					memoryUsage: memory.usage,
					memoryRaw: memory.raw,
					memoryCache: memory.cache,
					memoryLimit,
					memoryPercent: Math.round(memoryPercent * 100) / 100,
					networkRx: networkIO.rx,
					networkTx: networkIO.tx,
					blockRead: blockIO.read,
					blockWrite: blockIO.write
				};
			} catch (err) {
				// Silently skip failed containers
				return null;
			}
		});

		const allStats = await Promise.all(statsPromises);
		const validStats = allStats.filter((s): s is ContainerStats => s !== null);

		return json(validStats);
	} catch (error: any) {
		// Return 404 for deleted environments so client can clear stale cache
		if (error instanceof EnvironmentNotFoundError) {
			return json({ error: 'Environment not found' }, { status: 404 });
		}
		console.error('Failed to get container stats:', error.message || error);
		return json([], { status: 200 }); // Return empty array instead of error
	}
};
