import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pauseContainer, inspectContainer } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { auditContainer } from '$lib/server/audit';
import { validateDockerIdParam } from '$lib/server/docker-validation';

export const POST: RequestHandler = async (event) => {
	const { params, url, cookies } = event;
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context (pause/unpause uses 'stop' permission)
	if (auth.authEnabled && !await auth.can('containers', 'stop', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const details = await inspectContainer(params.id, envIdNum);
		const containerName = details.Name.replace(/^\//, '');
		await pauseContainer(params.id, envIdNum);

		// Audit log
		await auditContainer(event, 'pause', params.id, containerName, envIdNum);

		return json({ success: true });
	} catch (error) {
		console.error('Failed to pause container:', error);
		return json({ error: 'Failed to pause container' }, { status: 500 });
	}
};
