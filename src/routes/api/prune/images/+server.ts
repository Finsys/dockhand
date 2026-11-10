import { json } from '@sveltejs/kit';
import { pruneImages } from '$lib/server/docker';
import { prunedImageCount } from '$lib/utils/pruned-image-count';
import { authorize } from '$lib/server/authorize';
import { audit } from '$lib/server/audit';
import { createJobResponse } from '$lib/server/sse';
import type { RequestHandler } from './$types';

/**
 * POST /api/prune/images - Remove unused images (streamed job)
 *
 * @openapi
 * summary: Prune unused Docker images, streaming progress as a Server-Sent Events job
 * description: Returns a text/event-stream. On completion a `result` event carries { success, result } on success or { success:false, error } on failure — the operation itself never returns a non-200 HTTP status once the permission check passes.
 * query: dangling:boolean When not "false", prune only dangling images; set "dangling=false" to prune all unused images (defaults to dangling-only)
 * query: env:integer Target environment id; scopes both the prune operation and the permission check (defaults to the local environment) (from GET /api/environments)
 * resp-200: Server-Sent Events stream; the final `result` event contains { success, result } or { success:false, error }
 * resp-403: Permission denied — requires the "remove" permission on images for the target environment
 */
export const POST: RequestHandler = async (event) => {
	const { url, cookies } = event;
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;
	const danglingOnly = url.searchParams.get('dangling') !== 'false';

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('images', 'remove', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	return createJobResponse(async (send) => {
		try {
			const result = await pruneImages(danglingOnly, envIdNum);
			const space = result?.SpaceReclaimed === undefined ? 'space freed not known' : `${result.SpaceReclaimed} bytes freed`;
			console.log(`[Prune] env ${envIdNum ?? 'local'}: manual ${danglingOnly ? 'dangling' : 'all unused'} image prune removed ${prunedImageCount(result?.ImagesDeleted)} images, ${space}`);

			// Audit log
			await audit(event, 'prune', 'image', {
				environmentId: envIdNum,
				description: `Pruned ${danglingOnly ? 'dangling' : 'unused'} images`,
				details: { danglingOnly, result }
			});

			send('result', { success: true, result });
		} catch (error) {
			console.error(`[Prune] env ${envIdNum ?? 'local'}: manual image prune failed:`, error);
			send('result', { success: false, error: 'Failed to prune images' });
		}
	}, event.request);
};
