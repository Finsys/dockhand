import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getContainerStats, EnvironmentNotFoundError } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { hasEnvironments } from '$lib/server/db';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import { calculateCpuPercent, calculateMemoryUsage, calculateMemoryLimit, calculateNetworkIO, calculateBlockIO } from '$lib/server/stats-calc-core';

/**
 * GET /api/containers/{id}/stats - Get a single container's resource stats
 *
 * @openapi
 * summary: Return a one-shot CPU/memory/network/block-IO stats snapshot for a container (Docker-CLI-equivalent memory accounting)
 * path: id:string! Container ID or name (from GET /api/containers)
 * query: env:integer! The target environment ID the container lives in (from GET /api/environments)
 * resp-200: {cpuPercent:number!, memoryUsage:integer!, memoryRaw:integer!, memoryCache:integer!, memoryLimit:integer!, memoryPercent:number!, networkRx:integer!, networkTx:integer!, blockRead:integer!, blockWrite:integer!, timestamp:integer!}
 * resp-403: Permission denied
 * resp-404: No environment configured, the environment was not found, or the container was not found
 * resp-500: Failed to read the container stats
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context (stats uses view permission)
	if (auth.authEnabled && !await auth.can('containers', 'view', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Early return if no environments configured (fresh install)
	if (!await hasEnvironments()) {
		return json({ error: 'No environment configured' }, { status: 404 });
	}

	try {
		const stats = await getContainerStats(params.id, envIdNum) as any;

		const cpuPercent = calculateCpuPercent(stats);
		const memory = calculateMemoryUsage(stats.memory_stats);
		const memoryLimit = calculateMemoryLimit(stats);
		const memoryPercent = memoryLimit > 0 ? (memory.usage / memoryLimit) * 100 : 0;
		const networkIO = calculateNetworkIO(stats);
		const blockIO = calculateBlockIO(stats);

		return json({
			cpuPercent: Math.round(cpuPercent * 100) / 100,
			memoryUsage: memory.usage,
			memoryRaw: memory.raw,
			memoryCache: memory.cache,
			memoryLimit,
			memoryPercent: Math.round(memoryPercent * 100) / 100,
			networkRx: networkIO.rx,
			networkTx: networkIO.tx,
			blockRead: blockIO.read,
			blockWrite: blockIO.write,
			timestamp: Date.now()
		});
	} catch (error: any) {
		// Return 404 for deleted environments so client can clear stale cache
		if (error instanceof EnvironmentNotFoundError) {
			return json({ error: 'Environment not found' }, { status: 404 });
		}
		if (error.statusCode === 404) {
			return json({ error: 'Container not found' }, { status: 404 });
		}
		console.error('Failed to get container stats:', error.message || error);
		return json({ error: error.message || 'Failed to get stats' }, { status: 500 });
	}
};
