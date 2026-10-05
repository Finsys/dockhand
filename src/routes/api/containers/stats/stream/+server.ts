import type { RequestHandler } from './$types';
import { listContainers, getContainerStats, EnvironmentNotFoundError } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { hasEnvironments } from '$lib/server/db';
import type { ContainerStats } from '$lib/types';
import { calculateCpuPercent, calculateMemoryUsage, calculateMemoryLimit, calculateNetworkIO, calculateBlockIO } from '$lib/server/stats-calc-core';

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	const timeoutPromise = new Promise<T>((resolve) => {
		timeoutId = setTimeout(() => resolve(fallback), ms);
	});
	return Promise.race([promise, timeoutPromise]).finally(() => {
		if (timeoutId !== null) clearTimeout(timeoutId);
	});
}

/**
 * @openapi
 * summary: Stream live CPU/memory/network/block-IO stats for all running containers in an environment (one snapshot round, then closes)
 * query: env:integer Environment id — an immediate "done" event is sent if omitted or no environments are configured (from GET /api/environments)
 * resp-200: text/event-stream SSE stream ("stat" events per container with {id,name,cpuPercent,memoryUsage,memoryRaw,memoryCache,memoryLimit,memoryPercent,networkRx,networkTx,blockRead,blockWrite}, an "error" event on environment-not-found, then a final "done" event)
 * resp-403: Permission denied
 */
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

				// All at once, deliberately. The daemon samples CPU twice per call, so
				// each one costs about two seconds no matter what; anything narrower
				// than "every container" multiplies that into the wait for a table the
				// user is watching. The collection worker paces its own fan-out because
				// it runs in the background, where waiting is free.
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
						const memoryLimit = calculateMemoryLimit(stats);
						const memoryPercent = memoryLimit > 0 ? (memory.usage / memoryLimit) * 100 : 0;
						const networkIO = calculateNetworkIO(stats);
						const blockIO = calculateBlockIO(stats);

						const stat: ContainerStats = {
							id: container.id,
							name: container.name,
							// Same field the one-shot endpoint reports, so a consumer can group
							// by stack whichever of the two it reads.
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
