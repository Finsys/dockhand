import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectContainerToNetwork, inspectNetwork } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { auditNetwork } from '$lib/server/audit';
import { validateDockerIdParam } from '$lib/server/docker-validation';

export const POST: RequestHandler = async (event) => {
	const { params, url, request, cookies } = event;
	const invalid = validateDockerIdParam(params.id, 'network');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('networks', 'connect', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {

		const body = await request.json();
		const { containerId, containerName } = body;

		if (!containerId) {
			return json({ error: 'Container ID is required' }, { status: 400 });
		}

		const invalidContainer = validateDockerIdParam(containerId, 'container');
		if (invalidContainer) return invalidContainer;

		// Get network name for audit
		let networkName = params.id;
		try {
			const networkInfo = await inspectNetwork(params.id, envIdNum);
			networkName = networkInfo.Name || params.id;
		} catch {
			// Use ID if can't get name
		}

		await connectContainerToNetwork(params.id, containerId, envIdNum);

		// Audit log
		await auditNetwork(event, 'connect', params.id, networkName, envIdNum, {
			containerId,
			containerName: containerName || containerId
		});

		return json({ success: true });
	} catch (error: any) {
		console.error('Failed to connect container to network:', error);
		return json({
			error: 'Failed to connect container to network',
			details: error.message
		}, { status: 500 });
	}
};
