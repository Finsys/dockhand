import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { inspectNetwork } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';

/**
 * @openapi
 * summary: Inspect a Docker network by ID (a malformed ID is rejected with 400 by input validation)
 * path: id:string! Docker network ID (from GET /api/networks)
 * query: env:integer Environment the network belongs to (from GET /api/environments)
 * resp-200: {Id:string!, Name:string!, Driver:string, Scope:string, IPAM:{}, Containers:{}}
 * resp-403: Permission denied
 * resp-500: Failed to inspect network
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const invalid = validateDockerIdParam(params.id, 'network');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('networks', 'inspect', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const networkData = await inspectNetwork(params.id, envIdNum);
		return json(networkData);
	} catch (error) {
		console.error('Failed to inspect network:', error);
		return json({ error: 'Failed to inspect network' }, { status: 500 });
	}
};
