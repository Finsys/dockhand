import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listVolumeDirectory, getVolumeUsage } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';

/**
 * @openapi
 * summary: Browse a directory inside a Docker volume via a cached helper container; the volume is mounted read-only when in use by other containers
 * path: name:string! Docker volume name (from GET /api/volumes)
 * query: env:integer Environment ID the volume belongs to (from GET /api/environments)
 * query: path:string Directory path inside the volume to list (defaults to "/")
 * resp-200: {path:string!, entries:array<{name:string!, type:string!, size:integer!, permissions:string!, owner:string!, group:string!, modified:string!}>!, usage:array<{containerId:string!, containerName:string!, state:string!}>!, isInUse:boolean!, helperId:string!}
 * resp-200-example: {"path":"/","entries":[{"name":"data","type":"directory","size":4096,"permissions":"drwxr-xr-x","owner":"root","group":"root","modified":"2026-06-01 10:00"}],"usage":[],"isInUse":false,"helperId":"abc123"}
 * resp-403: Permission denied (requires volumes:inspect) or permission denied accessing the path
 * resp-404: Directory not found
 * resp-500: Failed to browse volume
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const invalid = validateDockerIdParam(params.name, 'volume');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;
	const path = url.searchParams.get('path') || '/';

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('volumes', 'inspect', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		// Check if volume is in use by any containers
		const usage = await getVolumeUsage(params.name, envIdNum);
		const isInUse = usage.length > 0;

		// Mount read-only if in use, otherwise writable
		const result = await listVolumeDirectory(params.name, path, envIdNum, isInUse);

		// Note: Helper container is cached and reused for subsequent requests.
		// Cache TTL handles cleanup automatically.

		return json({
			path: result.path,
			entries: result.entries,
			usage,
			isInUse,
			// Expose helper container ID so frontend can use container file endpoints
			helperId: result.containerId
		});
	} catch (error: any) {
		console.error('Failed to browse volume:', error);

		if (error.message?.includes('No such file or directory')) {
			return json({ error: 'Directory not found', path: url.searchParams.get('path') || '/' }, { status: 404 });
		}
		if (error.message?.includes('Permission denied')) {
			return json({ error: 'Permission denied to access this path' }, { status: 403 });
		}

		return json({
			error: 'Failed to browse volume',
			details: error.message || String(error)
		}, { status: 500 });
	}
};
