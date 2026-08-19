import { json } from '@sveltejs/kit';
import { deleteContainerPath } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';

/**
 * DELETE /api/containers/{id}/files/delete - Delete a path in a container
 *
 * @openapi
 * summary: Delete a file or directory inside a container (requires the 'exec' permission)
 * path: id:string! Container ID or name (from GET /api/containers)
 * query: env:integer The target environment ID (omit for the local/default Docker host) (from GET /api/environments)
 * query: path:string! Absolute path inside the container to delete
 * resp-200: {success:boolean!, path:string!}
 * resp-200-example: {"success":true,"path":"/app/tmp/old.log"}
 * resp-400: Path missing, a refused critical-path delete, a non-empty directory, or the container is not running
 * resp-403: Permission denied, or read-only file system
 * resp-404: Path not found
 * resp-500: Failed to delete the path
 */
export const DELETE: RequestHandler = async ({ params, url, cookies }) => {
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const path = url.searchParams.get('path');
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('containers', 'exec', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		if (!path) {
			return json({ error: 'Path is required' }, { status: 400 });
		}

		await deleteContainerPath(params.id, path, envIdNum);

		return json({ success: true, path });
	} catch (error: any) {
		console.error('Error deleting path:', error);
		const msg = error.message || String(error);

		if (msg.includes('Permission denied')) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}
		if (msg.includes('No such file or directory')) {
			return json({ error: 'Path not found' }, { status: 404 });
		}
		if (msg.includes('Cannot delete critical')) {
			return json({ error: msg }, { status: 400 });
		}
		if (msg.includes('Read-only file system')) {
			return json({ error: 'File system is read-only' }, { status: 403 });
		}
		if (msg.includes('Directory not empty')) {
			return json({ error: 'Directory is not empty' }, { status: 400 });
		}
		if (msg.includes('container is not running')) {
			return json({ error: 'Container is not running' }, { status: 400 });
		}

		return json({ error: `Failed to delete: ${msg}` }, { status: 500 });
	}
};
