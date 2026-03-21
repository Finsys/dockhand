import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { inspectContainer } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';

export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('containers', 'inspect', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const containerData = await inspectContainer(params.id, envIdNum);
		return json(containerData);
	} catch (error) {
		console.error('Failed to inspect container:', error);
		return json({ error: 'Failed to inspect container' }, { status: 500 });
	}
};
