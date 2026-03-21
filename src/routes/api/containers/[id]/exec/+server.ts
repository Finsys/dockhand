/**
 * Container Exec API
 *
 * POST: Creates an exec instance for terminal attachment
 * Returns exec ID that can be used for WebSocket connection
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createExec, getDockerConnectionInfo } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';

export const POST: RequestHandler = async ({ params, request, cookies, url }) => {
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);
	if (auth.authEnabled && !auth.isAuthenticated) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const containerId = params.id;
	const envIdParam = url.searchParams.get('envId');
	const envId = envIdParam ? parseInt(envIdParam, 10) : undefined;

	// Permission check with environment context
	if (!await auth.can('containers', 'exec', envId)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const body = await request.json().catch(() => ({}));
		const shell = body.shell || '/bin/sh';
		const user = body.user || 'root';

		// Create exec instance
		const exec = await createExec({
			containerId,
			cmd: [shell],
			user,
			envId
		});

		// Get connection info for the frontend
		const connectionInfo = await getDockerConnectionInfo(envId);

		return json({
			execId: exec.Id,
			connectionInfo: {
				type: connectionInfo.type,
				host: connectionInfo.host,
				port: connectionInfo.port
			}
		});
	} catch (error: any) {
		console.error('Failed to create exec:', error);
		return json(
			{ error: error.message || 'Failed to create exec instance' },
			{ status: 500 }
		);
	}
};
