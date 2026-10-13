import { json } from '@sveltejs/kit';
import { chownContainerPath } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import { parseChownSpec } from '$lib/server/chown-spec-core';
import type { RequestHandler } from './$types';

/**
 * POST /api/containers/{id}/files/chown - Change ownership of a path in a container
 *
 * @openapi
 * summary: Change the owner (and optional group) of a file or directory inside a container (requires the 'exec' permission)
 * path: id:string! Container ID or name (from GET /api/containers)
 * query: env:integer! The target environment ID the container lives in (from GET /api/environments)
 * body: {path:string!, owner:string!, recursive:boolean}
 * body-example: {"path":"/app/data","owner":"1000:1000","recursive":true}
 * resp-200: {success:boolean!, path:string!, owner:string!, recursive:boolean!}
 * resp-200-example: {"success":true,"path":"/app/data","owner":"1000:1000","recursive":true}
 * resp-400: Path or owner missing, an invalid owner spec, or the container is not running
 * resp-403: Permission denied, read-only file system, or operation not permitted
 * resp-404: Path not found
 * resp-500: Failed to change ownership
 */
export const POST: RequestHandler = async ({ params, url, cookies, request }) => {
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? Number.parseInt(envId) : undefined;

	if (auth.authEnabled && !await auth.can('containers', 'exec', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const body = await request.json();
		const { path, owner, recursive } = body;

		if (!path || typeof path !== 'string') {
			return json({ error: 'Path is required' }, { status: 400 });
		}

		const spec = parseChownSpec(owner);
		if ('error' in spec) {
			return json({ error: spec.error }, { status: 400 });
		}

		await chownContainerPath(params.id, path, spec.value, recursive === true, envIdNum);

		return json({ success: true, path, owner: spec.value, recursive: recursive === true });
	} catch (error: any) {
		console.error('Error changing ownership:', error);
		const msg = error.message || String(error);

		if (msg.includes('Permission denied')) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}
		if (msg.includes('No such file or directory')) {
			return json({ error: 'Path not found' }, { status: 404 });
		}
		if (msg.includes('invalid user') || msg.includes('invalid group')) {
			return json({ error: 'That user or group does not exist in the container' }, { status: 400 });
		}
		if (msg.includes('Read-only file system')) {
			return json({ error: 'File system is read-only' }, { status: 403 });
		}
		if (msg.includes('Operation not permitted')) {
			return json({ error: 'Operation not permitted' }, { status: 403 });
		}
		if (msg.includes('container is not running')) {
			return json({ error: 'Container is not running' }, { status: 400 });
		}

		return json({ error: `Failed to change ownership: ${msg}` }, { status: 500 });
	}
};
