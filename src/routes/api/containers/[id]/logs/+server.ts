import { json } from '@sveltejs/kit';
import { getContainerLogs } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';

/**
 * GET /api/containers/{id}/logs - Read container logs (non-streaming)
 *
 * @openapi
 * summary: Return the last N lines of a container's combined stdout/stderr logs as a single string
 * path: id:string! Container ID or name (from GET /api/containers)
 * query: env:integer The target environment ID (omit for the local/default Docker host) (from GET /api/environments)
 * query: tail:integer Number of trailing log lines to return (default 100)
 * query: since:string Only return logs since this time (Unix timestamp or Docker duration, e.g. 10m)
 * query: until:string Only return logs before this time (Unix timestamp or Docker duration)
 * resp-200: {logs:string!}
 * resp-403: Permission denied
 * resp-500: Failed to read the container logs
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const tail = url.searchParams.get('tail') || '100';
	const since = url.searchParams.get('since') || undefined;
	const until = url.searchParams.get('until') || undefined;
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('containers', 'logs', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const logs = await getContainerLogs(params.id, tail === 'all' ? 'all' : parseInt(tail), envIdNum, since, until);
		return json({ logs });
	} catch (error: any) {
		console.error('Error getting container logs:', error?.message || error, error?.stack);
		return json({ error: 'Failed to get container logs', details: error?.message }, { status: 500 });
	}
};
