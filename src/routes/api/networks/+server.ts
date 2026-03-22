import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listNetworks, createNetwork, EnvironmentNotFoundError, DockerConnectionError, type CreateNetworkOptions } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { auditNetwork } from '$lib/server/audit';
import { hasEnvironments } from '$lib/server/db';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('networks', 'view', envIdNum)) {
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
		const networks = await listNetworks(envIdNum);
		return json(networks);
	} catch (error) {
		if (error instanceof EnvironmentNotFoundError) {
			return json({ error: 'Environment not found' }, { status: 404 });
		}
		if (!(error instanceof DockerConnectionError)) {
			console.error('Failed to list networks:', error);
		}
		return json({ error: 'Failed to list networks' }, { status: 500 });
	}
};

export const POST: RequestHandler = async (event) => {
	const { url, request, cookies } = event;
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('networks', 'create', envIdNum)) {
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
			return json({ error: 'Network name is required' }, { status: 400 });
		}

		const options: CreateNetworkOptions = {
			name: body.name,
			driver: body.driver || 'bridge',
			internal: body.internal || false,
			attachable: body.attachable || false,
			ingress: body.ingress || false,
			enableIPv6: body.enableIPv6 || false,
			options: body.options || {},
			labels: body.labels || {}
		};

		// Add IPAM configuration if provided
		if (body.ipam) {
			options.ipam = {
				driver: body.ipam.driver || 'default',
				config: body.ipam.config || [],
				options: body.ipam.options || {}
			};
		}

		const network = await createNetwork(options, envIdNum);

		// Audit log
		await auditNetwork(event, 'create', network.Id, body.name, envIdNum, { driver: options.driver });

		return json({ success: true, id: network.Id });
	} catch (error: any) {
		console.error('Failed to create network:', error);
		return json({
			error: 'Failed to create network',
			details: error.message || String(error)
		}, { status: 500 });
	}
};
