import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listVolumes, createVolume, EnvironmentNotFoundError, DockerConnectionError, type CreateVolumeOptions } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { auditVolume } from '$lib/server/audit';
import { hasEnvironments } from '$lib/server/db';

/**
 * @openapi
 * summary: List Docker volumes for an environment; returns an empty array when no environment is specified
 * query: env:integer Environment ID to list volumes for (from GET /api/environments)
 * resp-200: array<{Name:string!, Driver:string!, Mountpoint:string, Scope:string, CreatedAt:string}>
 * resp-200-example: [{"Name":"web_data","Driver":"local","Mountpoint":"/var/lib/docker/volumes/web_data/_data","Scope":"local","CreatedAt":"2026-06-01T10:00:00Z"}]
 * resp-403: Permission denied (requires volumes:view, or environment access denied on enterprise)
 * resp-404: Environment not found
 * resp-500: Failed to list volumes
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('volumes', 'view', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !await auth.canAccessEnvironment(envIdNum)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	// Early return if no environment specified
	if (!envIdNum) {
		return json([]);
	}

	try {
		const volumes = await listVolumes(envIdNum);
		return json(volumes);
	} catch (error: any) {
		if (error instanceof EnvironmentNotFoundError) {
			return json({ error: 'Environment not found' }, { status: 404 });
		}
		if (!(error instanceof DockerConnectionError)) {
			console.error('Failed to list volumes:', error);
		}
		return json({ error: 'Failed to list volumes' }, { status: 500 });
	}
};

/**
 * @openapi
 * summary: Create a Docker volume in an environment
 * query: env:integer Environment ID to create the volume in (from GET /api/environments)
 * body: {name:string!, driver:string, driverOpts:{}, labels:{}}
 * body-example: {"name":"web_data","driver":"local","driverOpts":{},"labels":{"app":"web"}}
 * resp-200: {success:boolean!, name:string!}
 * resp-200-example: {"success":true,"name":"web_data"}
 * resp-400: Volume name is required
 * resp-403: Permission denied (requires volumes:create, or environment access denied on enterprise)
 * resp-500: Failed to create volume
 */
export const POST: RequestHandler = async (event) => {
	const { url, request, cookies } = event;
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('volumes', 'create', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !await auth.canAccessEnvironment(envIdNum)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	try {
		const body = await request.json();

		// Validate required fields
		if (!body.name) {
			return json({ error: 'Volume name is required' }, { status: 400 });
		}

		const options: CreateVolumeOptions = {
			name: body.name,
			driver: body.driver || 'local',
			driverOpts: body.driverOpts || {},
			labels: body.labels || {}
		};

		const volume = await createVolume(options, envIdNum);

		// Audit log
		await auditVolume(event, 'create', volume.Name, body.name, envIdNum, { driver: options.driver });

		return json({ success: true, name: volume.Name });
	} catch (error: any) {
		console.error('Failed to create volume:', error);
		return json({
			error: 'Failed to create volume',
			details: error.message || String(error)
		}, { status: 500 });
	}
};
