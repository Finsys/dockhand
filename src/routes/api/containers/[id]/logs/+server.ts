import { json } from '@sveltejs/kit';
import { getContainerLogs } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const tail = parseInt(url.searchParams.get('tail') || '100');
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('containers', 'logs', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const logs = await getContainerLogs(params.id, tail, envIdNum);
		return json({ logs });
	} catch (error: any) {
		console.error('Error getting container logs:', error?.message || error, error?.stack);
		return json({ error: 'Failed to get container logs', details: error?.message }, { status: 500 });
	}
};
