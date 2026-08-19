import { json } from '@sveltejs/kit';
import { renameContainerPath } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';

/**
 * POST /api/containers/{id}/files/rename - Rename/move a path in a container
 *
 * @openapi
 * summary: Rename or move a file or directory inside a container (requires the 'exec' permission)
 * path: id:string! Container ID or name (from GET /api/containers)
 * query: env:integer The target environment ID (omit for the local/default Docker host) (from GET /api/environments)
 * body: {oldPath:string!, newPath:string!}
 * body-example: {"oldPath":"/app/config.yaml","newPath":"/app/config.old.yaml"}
 * resp-200: {success:boolean!, oldPath:string!, newPath:string!}
 * resp-200-example: {"success":true,"oldPath":"/app/config.yaml","newPath":"/app/config.old.yaml"}
 * resp-400: oldPath or newPath missing, or the container is not running
 * resp-403: Permission denied, or read-only file system
 * resp-404: Source path not found
 * resp-409: Destination already exists
 * resp-500: Failed to rename the path
 */
export const POST: RequestHandler = async ({ params, url, cookies, request }) => {
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('containers', 'exec', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const body = await request.json();
		const { oldPath, newPath } = body;

		if (!oldPath || typeof oldPath !== 'string') {
			return json({ error: 'Old path is required' }, { status: 400 });
		}

		if (!newPath || typeof newPath !== 'string') {
			return json({ error: 'New path is required' }, { status: 400 });
		}

		await renameContainerPath(params.id, oldPath, newPath, envIdNum);

		return json({ success: true, oldPath, newPath });
	} catch (error: any) {
		console.error('Error renaming path:', error);
		const msg = error.message || String(error);

		if (msg.includes('Permission denied')) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}
		if (msg.includes('No such file or directory')) {
			return json({ error: 'Source path not found' }, { status: 404 });
		}
		if (msg.includes('File exists') || msg.includes('Directory not empty')) {
			return json({ error: 'Destination already exists' }, { status: 409 });
		}
		if (msg.includes('Read-only file system')) {
			return json({ error: 'File system is read-only' }, { status: 403 });
		}
		if (msg.includes('container is not running')) {
			return json({ error: 'Container is not running' }, { status: 400 });
		}

		return json({ error: `Failed to rename: ${msg}` }, { status: 500 });
	}
};
