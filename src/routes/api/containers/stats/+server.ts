import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listContainers, getContainerStats, EnvironmentNotFoundError } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { hasEnvironments } from '$lib/server/db';
import type { ContainerStats } from '$lib/types';
import { withTimeout, sampleContainerStats } from '$lib/server/container-stats';

/**
 * GET /api/containers/stats - Get resource stats for all running containers
 *
 * @openapi
 * summary: Return a CPU/memory/network/block-IO stats snapshot for every running container in an environment (requires the 'view' permission)
 * description: Returns an empty array when no environment is configured or specified. With `debug=<name>` it returns the raw memory_stats for a single container instead. On internal error it returns an empty array with status 200.
 * query: env:integer! The target environment ID the container lives in (from GET /api/environments)
 * query: debug:string Return raw Docker stats for the single container with this name instead of the aggregate list
 * resp-200: Array of per-container stats snapshots (or, with `debug`, the raw stats for one container). Each entry carries `stack`, the compose project the container belongs to (null when standalone), so totals can be grouped without a second request. Note `memoryLimit` is the host limit each container reports, so take the MAXIMUM across a stack rather than the sum.
 * resp-403: Permission denied
 * resp-404: The requested debug container was not found
 */
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
			10000, // 10 second timeout
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

		// All at once, deliberately. The daemon samples CPU twice per call, so each
		// one costs about two seconds no matter what; anything narrower than "every
		// container" multiplies that into the caller's wait. The collection worker
		// paces its own fan-out because it runs in the background, where waiting
		// is free.
		const statsPromises = runningContainers.map((container) => sampleContainerStats(container, envIdNum));

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
