import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listContainers, EnvironmentNotFoundError } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { hasEnvironments } from '$lib/server/db';
import type { ContainerStats } from '$lib/types';
import { withTimeout, sampleContainerStats } from '$lib/server/container-stats';
import { groupStackStats } from '$lib/utils/stack-stats';

/**
 * @openapi
 * summary: Return a CPU/memory/network/block-IO stats snapshot per compose stack in an environment (needs stacks:view and containers:view)
 * description: Sums the stats of each stack's running containers, the same totals the stacks list shows. `memoryLimit` is the largest per-container limit, not a sum. Stacks with no running container are omitted. Returns an empty array when no environment is configured or specified, or on internal error.
 * query: env:integer! The target environment ID (from GET /api/environments)
 * resp-200: array<{name:string!, cpuPercent:number!, memoryUsage:integer!, memoryLimit:integer!, networkRx:integer!, networkTx:integer!, blockRead:integer!, blockWrite:integer!, runningCount:integer!}>
 * resp-200-desc: Array of per-stack totals sorted by name
 * resp-200-example: [{"name":"nextcloud","cpuPercent":1.42,"memoryUsage":412090368,"memoryLimit":16663232512,"networkRx":1048576,"networkTx":524288,"blockRead":0,"blockWrite":4096,"runningCount":2}]
 * resp-403: Permission denied, or no access to this environment
 * resp-404: Environment not found
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Per-stack totals expose per-container data, so both permissions are required.
	if (
		auth.authEnabled &&
		(!(await auth.can('stacks', 'view', envIdNum)) || !(await auth.can('containers', 'view', envIdNum)))
	) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	if (envIdNum && auth.isEnterprise && !(await auth.canAccessEnvironment(envIdNum))) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	if (!(await hasEnvironments()) || !envIdNum) {
		return json([]);
	}

	try {
		const containers = await withTimeout(listContainers(true, envIdNum), 10000, []);
		const running = containers.filter(
			(c) => c.state === 'running' && c.labels?.['com.docker.compose.project']
		);

		const samples = await Promise.all(running.map((c) => sampleContainerStats(c, envIdNum)));
		const statsById = new Map(
			samples.filter((s): s is ContainerStats => s !== null).map((s) => [s.id, s])
		);

		return json(groupStackStats(running, statsById));
	} catch (error: any) {
		if (error instanceof EnvironmentNotFoundError) {
			return json({ error: 'Environment not found' }, { status: 404 });
		}
		console.error('Failed to get stack stats:', error.message || error);
		return json([]);
	}
};
