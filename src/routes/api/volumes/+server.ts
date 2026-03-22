import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listVolumes, createVolume, EnvironmentNotFoundError, DockerConnectionError, type CreateVolumeOptions } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { auditVolume } from '$lib/server/audit';
import { hasEnvironments } from '$lib/server/db';

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
