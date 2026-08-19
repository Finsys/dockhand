import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { removeVolume, inspectVolume } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { auditVolume } from '$lib/server/audit';
import { validateDockerIdParam } from '$lib/server/docker-validation';

/**
 * @openapi
 * summary: Inspect a single Docker volume by name (the name is validated as a Docker identifier)
 * path: name:string! Docker volume name (from GET /api/volumes)
 * query: env:integer Environment ID the volume belongs to (from GET /api/environments)
 * resp-200: {Name:string!, Driver:string!, Mountpoint:string!, Scope:string, Labels:{}, Options:{}, CreatedAt:string}
 * resp-200-example: {"Name":"web_data","Driver":"local","Mountpoint":"/var/lib/docker/volumes/web_data/_data","Scope":"local","Labels":{},"Options":{},"CreatedAt":"2026-06-01T10:00:00Z"}
 * resp-403: Permission denied (requires volumes:inspect, or environment access denied on enterprise)
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

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !await auth.canAccessEnvironment(envIdNum)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	try {

		const volume = await inspectVolume(params.name, envIdNum);
		return json(volume);
	} catch (error: any) {
		const status = error.statusCode ?? 500;
		console.error(`Failed to inspect volume ${params.name}: ${error.message}`);
		return json({ error: 'Failed to inspect volume' }, { status });
	}
};

/**
 * @openapi
 * summary: Remove a Docker volume by name, optionally forcing removal
 * path: name:string! Docker volume name (from GET /api/volumes)
 * query: env:integer Environment ID the volume belongs to (from GET /api/environments)
 * query: force:boolean Force removal of the volume
 * resp-200: {success:boolean!}
 * resp-200-example: {"success":true}
 * resp-403: Permission denied (requires volumes:remove, or environment access denied on enterprise)
 */
export const DELETE: RequestHandler = async (event) => {
	const { params, url, cookies } = event;
	const invalid = validateDockerIdParam(params.name, 'volume');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const force = url.searchParams.get('force') === 'true';
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('volumes', 'remove', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !await auth.canAccessEnvironment(envIdNum)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	try {

		await removeVolume(params.name, force, envIdNum);

		// Audit log
		await auditVolume(event, 'delete', params.name, params.name, envIdNum, { force });

		return json({ success: true });
	} catch (error: any) {
		const status = error.statusCode ?? 500;
		if (status === 404) {
			console.warn(`Failed to remove volume ${params.name}: ${error.message}`);
		} else {
			console.error(`Failed to remove volume ${params.name}: ${error.message}`);
		}
		return json({ error: 'Failed to remove volume', details: error.message }, { status });
	}
};
