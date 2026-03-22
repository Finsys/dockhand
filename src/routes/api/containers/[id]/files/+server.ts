import { json } from '@sveltejs/kit';
import { listContainerDirectory } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const path = url.searchParams.get('path') || '/';
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;
	const simpleLs = url.searchParams.get('simpleLs') === 'true';

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('containers', 'view', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const result = await listContainerDirectory(
			params.id,
			path,
			envIdNum,
			simpleLs
		);

		return json(result);
	} catch (error: any) {
		if (error?.statusCode === 404) {
			return json({ error: error.json?.message || 'Container not found' }, { status: 404 });
		}
		console.error('Error listing container directory:', error?.message || error);
		return json({ error: error.message || 'Failed to list directory' }, { status: 500 });
	}
};
