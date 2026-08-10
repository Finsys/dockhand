import { json } from '@sveltejs/kit';
import { createContainerFile, createContainerDirectory } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';

/**
 * POST /api/containers/{id}/files/create - Create a file or directory in a container
 *
 * @openapi
 * summary: Create an empty file or a directory inside a container (requires the 'exec' permission)
 * path: id:string! Container ID or name (from GET /api/containers)
 * query: env:integer The target environment ID (omit for the local/default Docker host) (from GET /api/environments)
 * body: {path:string!, type:string!}
 * body-example: {"path":"/app/data","type":"directory"}
 * resp-200: {success:boolean!, path:string!, type:string!}
 * resp-200-example: {"success":true,"path":"/app/data","type":"directory"}
 * resp-400: Path missing, type not "file" or "directory", or the container is not running
 * resp-403: Permission denied
 * resp-404: Parent directory not found
 * resp-409: Path already exists
 * resp-500: Failed to create the path
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
		const { path, type } = body;

		if (!path || typeof path !== 'string') {
			return json({ error: 'Path is required' }, { status: 400 });
		}

		if (type !== 'file' && type !== 'directory') {
			return json({ error: 'Type must be "file" or "directory"' }, { status: 400 });
		}

		if (type === 'file') {
			await createContainerFile(params.id, path, envIdNum);
		} else {
			await createContainerDirectory(params.id, path, envIdNum);
		}

		return json({ success: true, path, type });
	} catch (error: any) {
		console.error('Error creating path:', error);
		const msg = error.message || String(error);

		if (msg.includes('Permission denied')) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}
		if (msg.includes('File exists')) {
			return json({ error: 'Path already exists' }, { status: 409 });
		}
		if (msg.includes('No such file or directory')) {
			return json({ error: 'Parent directory not found' }, { status: 404 });
		}
		if (msg.includes('container is not running')) {
			return json({ error: 'Container is not running' }, { status: 400 });
		}

		return json({ error: `Failed to create: ${msg}` }, { status: 500 });
	}
};
