import { json } from '@sveltejs/kit';
import { pruneBuildCache } from '$lib/server/docker';
import { invalidateDiskUsage } from '$lib/server/disk-usage-cache';
import { authorize } from '$lib/server/authorize';
import { audit } from '$lib/server/audit';
import { createJobResponse } from '$lib/server/sse';
import type { RequestHandler } from './$types';

/**
 * POST /api/prune/build-cache - Reclaim Docker build cache (streamed job)
 *
 * @openapi
 * summary: Prune the Docker build cache, streaming progress as a Server-Sent Events job
 * description: Returns a text/event-stream. On completion a `result` event carries { success, result } on success or { success:false, error } on failure - the operation itself never returns a non-200 HTTP status once the permission check passes. Wraps Docker's POST /build/prune; the disk-keep parameter is reserved-space on API 1.48+ and keep-storage below.
 * query: env:integer Target environment id; scopes both the prune operation and the permission check (defaults to the local environment) (from GET /api/environments)
 * query: all:boolean When "true", prune all unused build cache; otherwise only dangling cache (the default, matching docker builder prune)
 * query: until:string Age filter, e.g. "336h" or "24h" - prune only cache older than this (Go duration or timestamp)
 * query: reserved-space:integer Bytes of build cache to keep; mapped to reserved-space (API 1.48+) or keep-storage below
 * resp-200: Server-Sent Events stream; the final `result` event contains { success, result } or { success:false, error }
 * resp-403: Permission denied - requires the "remove" permission on images for the target environment
 */
export const POST: RequestHandler = async (event) => {
	const { url, cookies } = event;
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission: build cache is an image-build artifact, gated like image prune.
	if (auth.authEnabled && !await auth.can('images', 'remove', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const all = url.searchParams.get('all') === 'true';
	const until = url.searchParams.get('until') || undefined;
	const reservedRaw = url.searchParams.get('reserved-space');
	const reservedSpace = reservedRaw !== null ? parseInt(reservedRaw) : undefined;

	return createJobResponse(async (send) => {
		try {
			const result = await pruneBuildCache(
				{ all, until, reservedSpace: Number.isFinite(reservedSpace as number) ? reservedSpace : undefined },
				envIdNum
			).finally(() => invalidateDiskUsage(envIdNum));

			const space = result?.SpaceReclaimed === undefined ? 'space freed not known' : `${result.SpaceReclaimed} bytes freed`;
			console.log(`[Prune] env ${envIdNum ?? 'local'}: manual ${all ? 'all' : 'dangling'} build cache prune removed ${result?.CachesDeleted?.length ?? 0} records, ${space}`);

			await audit(event, 'prune', 'build_cache', {
				environmentId: envIdNum,
				description: `Pruned ${all ? 'unused' : 'dangling'} build cache`,
				details: { all, until, reservedSpace, result }
			});

			send('result', { success: true, result });
		} catch (error) {
			console.error(`[Prune] env ${envIdNum ?? 'local'}: manual build cache prune failed:`, error);
			send('result', { success: false, error: 'Failed to prune build cache' });
		}
	}, event.request);
};
