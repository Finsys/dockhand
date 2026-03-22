import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { removeNetwork, inspectNetwork } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { auditNetwork } from '$lib/server/audit';
import { validateDockerIdParam } from '$lib/server/docker-validation';

export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const invalid = validateDockerIdParam(params.id, 'network');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('networks', 'inspect', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !await auth.canAccessEnvironment(envIdNum)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	try {

		const network = await inspectNetwork(params.id, envIdNum);
		return json(network);
	} catch (error) {
		console.error('Failed to inspect network:', error);
		return json({ error: 'Failed to inspect network' }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async (event) => {
	const { params, url, cookies } = event;
	const invalid = validateDockerIdParam(params.id, 'network');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('networks', 'remove', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !await auth.canAccessEnvironment(envIdNum)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	try {

		// Get network name before deletion for audit
		let networkName = params.id;
		try {
			const networkInfo = await inspectNetwork(params.id, envIdNum);
			networkName = networkInfo.Name || params.id;
		} catch {
			// Use ID if can't get name
		}

		await removeNetwork(params.id, envIdNum);

		// Audit log
		await auditNetwork(event, 'delete', params.id, networkName, envIdNum);

		return json({ success: true });
	} catch (error: any) {
		console.error('Failed to remove network:', error);
		return json({ error: 'Failed to remove network', details: error.message }, { status: 500 });
	}
};
