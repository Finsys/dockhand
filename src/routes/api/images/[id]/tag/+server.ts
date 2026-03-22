import { json } from '@sveltejs/kit';
import { tagImage } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request, url, cookies }) => {
	const invalid = validateDockerIdParam(params.id, 'image');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context (Tagging is similar to building/modifying)
	if (auth.authEnabled && !await auth.can('images', 'build', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const { repo, tag } = await request.json();
		if (!repo || typeof repo !== 'string') {
			return json({ error: 'Repository name is required' }, { status: 400 });
		}
		await tagImage(params.id, repo, tag || 'latest', envIdNum);
		return json({ success: true });
	} catch (error) {
		console.error('Error tagging image:', error);
		return json({ error: 'Failed to tag image' }, { status: 500 });
	}
};
