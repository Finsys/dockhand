import { getContainerStats } from '$lib/server/docker';
import type { ContainerStats } from '$lib/types';
import { calculateCpuPercent, calculateMemoryUsage, calculateMemoryLimit, calculateNetworkIO, calculateBlockIO } from '$lib/server/stats-calc-core';

/**
 * Resolve to `fallback` when the promise takes longer than `ms`.
 *
 * The timer is cleared once the race settles. Without that, sampling a stack of
 * thirty containers leaves thirty timers holding the event loop for the full
 * timeout after the answer has already been sent.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	const timeout = new Promise<T>((resolve) => {
		timer = setTimeout(() => resolve(fallback), ms);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer !== null) clearTimeout(timer);
	});
}

/** One stats snapshot for a running container, or null on timeout/error. */
export async function sampleContainerStats(
	container: { id: string; name: string; labels?: Record<string, string> },
	envId: number
): Promise<ContainerStats | null> {
	try {
		const stats = await withTimeout(
			getContainerStats(container.id, envId) as Promise<any>,
			8000, // 8 second timeout per container (TLS proxy + Docker CPU sampling needs ~2s)
			null
		);

		if (!stats) return null;

		const cpuPercent = calculateCpuPercent(stats);
		// Calculate memory usage the same way Docker CLI does (excludes cache)
		const memory = calculateMemoryUsage(stats.memory_stats);
		const memoryLimit = calculateMemoryLimit(stats);
		const memoryPercent = memoryLimit > 0 ? (memory.usage / memoryLimit) * 100 : 0;
		const networkIO = calculateNetworkIO(stats);
		const blockIO = calculateBlockIO(stats);

		return {
			id: container.id,
			name: container.name,
			// The compose project this container belongs to, so a caller can total a
			// stack without fetching the container list and joining on id. Null for a
			// standalone container.
			stack: container.labels?.['com.docker.compose.project'] ?? null,
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
	} catch {
		return null;
	}
}
