import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getImageHistory } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';

export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const invalid = validateDockerIdParam(params.id, 'image');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('images', 'inspect', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const history = await getImageHistory(params.id, envIdNum);
		return json(history);
	} catch (error) {
		console.error('Failed to get image history:', error);
		return json({ error: 'Failed to get image history' }, { status: 500 });
	}
};
