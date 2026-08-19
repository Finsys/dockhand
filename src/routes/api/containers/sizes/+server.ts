import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listContainersWithSize } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';

/**
 * GET /api/containers/sizes - List containers with their on-disk sizes
 *
 * @openapi
 * summary: List all containers in an environment together with their writable-layer and root-filesystem sizes (requires the 'view' permission)
 * query: env:integer The target environment ID (omit for the local/default Docker host) (from GET /api/environments)
 * resp-200: Array of containers with size metadata (SizeRw / SizeRootFs)
 * resp-403: Permission denied
 * resp-500: Failed to get container sizes (returns an empty object)
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('containers', 'view', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const sizes = await listContainersWithSize(true, envIdNum);
		return json(sizes);
	} catch (error) {
		console.error('Failed to get container sizes:', error);
		return json({}, { status: 500 });
	}
};
