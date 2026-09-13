import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { inspectVolume } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';

/**
 * @openapi
 * summary: Inspect a Docker volume by name, returning the raw Docker volume inspect object
 * path: name:string! Docker volume name (from GET /api/volumes)
 * query: env:integer Environment ID the volume belongs to (from GET /api/environments)
 * resp-200: {Name:string!, Driver:string!, Mountpoint:string!, Scope:string, Labels:{}, Options:{}, CreatedAt:string}
 * resp-200-example: {"Name":"web_data","Driver":"local","Mountpoint":"/var/lib/docker/volumes/web_data/_data","Scope":"local","Labels":{},"Options":{},"CreatedAt":"2026-06-01T10:00:00Z"}
 * resp-403: Permission denied (requires volumes:inspect)
 * resp-500: Failed to inspect volume
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const invalid = validateDockerIdParam(params.name, 'volume');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('volumes', 'inspect', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const volumeData = await inspectVolume(params.name, envIdNum);
		return json(volumeData);
	} catch (error) {
		console.error('Failed to inspect volume:', error);
		return json({ error: 'Failed to inspect volume' }, { status: 500 });
	}
};
