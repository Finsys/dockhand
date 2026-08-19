import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getImageHistory } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';

/**
 * GET /api/images/{id}/history - Layer history of an image
 *
 * @openapi
 * summary: Return the layer build history of a Docker image
 * path: id:string! Image ID or name whose history to return (from GET /api/images)
 * query: env:integer ID of the environment the image belongs to (from GET /api/environments)
 * resp-200: array<{Id:string, Created:integer, CreatedBy:string, Size:integer, Comment:string}>
 * resp-200-example: [{"Id":"sha256:abc123","Created":1719830400,"CreatedBy":"/bin/sh -c #(nop) CMD","Size":0,"Comment":""}]
 * resp-403: Permission denied
 * resp-500: Failed to get image history
 */
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
