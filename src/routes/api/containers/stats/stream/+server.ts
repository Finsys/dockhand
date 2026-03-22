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

function calculateMemoryUsage(memoryStats: any): { usage: number; raw: number; cache: number } {
	const raw = memoryStats?.usage || 0;
	const stats = memoryStats?.stats || {};
	const cache = stats.inactive_file ?? stats.total_inactive_file ?? 0;
	const usage = (cache > 0 && cache < raw) ? raw - cache : raw;
	return { usage, raw, cache };
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	const timeoutPromise = new Promise<T>((resolve) => {
		timeoutId = setTimeout(() => resolve(fallback), ms);
	});
	return Promise.race([promise, timeoutPromise]).finally(() => {
		if (timeoutId !== null) clearTimeout(timeoutId);
	});
}

export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	if (auth.authEnabled && !await auth.can('containers', 'view', envIdNum)) {
		return new Response(JSON.stringify({ error: 'Permission denied' }), {
			status: 403,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	if (!await hasEnvironments() || !envIdNum) {
		return new Response('event: done\ndata: {}\n\n', {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				'Connection': 'keep-alive',
				'X-Accel-Buffering': 'no'
			}
		});
	}

	let controllerClosed = false;
	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();

			const safeEnqueue = (data: string) => {
				if (!controllerClosed) {
					try {
						controller.enqueue(encoder.encode(data));
					} catch {
						controllerClosed = true;
					}
				}
			};

			try {
				const containers = await withTimeout(
					listContainers(true, envIdNum),
					10000,
					[]
				);
				const runningContainers = containers.filter(c => c.state === 'running');

				const statsPromises = runningContainers.map(async (container) => {
					try {
						const stats = await withTimeout(
							getContainerStats(container.id, envIdNum) as Promise<any>,
							8000,
							null
						);

						if (!stats) return;

						const cpuPercent = calculateCpuPercent(stats);
						const memory = calculateMemoryUsage(stats.memory_stats);
						const memoryLimit = stats.memory_stats?.limit || 1;
						const memoryPercent = (memory.usage / memoryLimit) * 100;
						const networkIO = calculateNetworkIO(stats);
						const blockIO = calculateBlockIO(stats);

						const stat: ContainerStats = {
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

						safeEnqueue(`event: stat\ndata: ${JSON.stringify(stat)}\n\n`);
					} catch {
						// Skip failed containers silently
					}
				});

				await Promise.all(statsPromises);
			} catch (error: any) {
				if (error instanceof EnvironmentNotFoundError) {
					safeEnqueue(`event: error\ndata: ${JSON.stringify({ error: 'Environment not found' })}\n\n`);
				}
			}

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
			controllerClosed = true;
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
};
