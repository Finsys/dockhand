import { json } from '@sveltejs/kit';
import { listContainerDirectory } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';

/**
 * GET /api/containers/{id}/files - List a directory inside a container
 *
 * @openapi
 * summary: List the contents of a directory inside a container's filesystem
 * path: id:string! Container ID or name (from GET /api/containers)
 * query: env:integer The target environment ID (omit for the local/default Docker host) (from GET /api/environments)
 * query: path:string Absolute directory path inside the container (default "/")
 * query: simpleLs:boolean Use a lightweight `ls` listing instead of a full stat of each entry
 * resp-200: Directory listing (entries with name, type, size and permission metadata)
 * resp-403: Permission denied
 * resp-404: Container not found
 * resp-500: Failed to list the directory
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const path = url.searchParams.get('path') || '/';
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;
	const simpleLs = url.searchParams.get('simpleLs') === 'true';

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('containers', 'view', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const result = await listContainerDirectory(
			params.id,
			path,
			envIdNum,
			simpleLs
		);

		return json(result);
	} catch (error: any) {
		if (error?.statusCode === 404) {
			return json({ error: error.json?.message || 'Container not found' }, { status: 404 });
		}
		console.error('Error listing container directory:', error?.message || error);
		return json({ error: error.message || 'Failed to list directory' }, { status: 500 });
	}
};
