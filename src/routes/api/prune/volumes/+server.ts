import { json } from '@sveltejs/kit';
import { pruneVolumes } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { audit } from '$lib/server/audit';
import type { RequestHandler } from './$types';

/**
 * POST /api/prune/volumes - Remove all unused volumes
 *
 * @openapi
 * summary: Prune (delete) all unused Docker volumes in the target environment
 * query: env:integer Target environment id; scopes both the prune operation and the permission check (defaults to the local environment) (from GET /api/environments)
 * resp-200: Returns { success: true, result } where result is the Docker volume-prune report (deleted volume names, space reclaimed)
 * resp-200-example: {"success":true,"result":{"VolumesDeleted":["orphan-data"],"SpaceReclaimed":20971520}}
 * resp-403: Permission denied — requires the "remove" permission on volumes for the target environment
 * resp-500: Failed to prune volumes (Docker error)
 */
export const POST: RequestHandler = async (event) => {
	const { url, cookies } = event;
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('volumes', 'remove', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const result = await pruneVolumes(envIdNum);

		// Audit log
		await audit(event, 'prune', 'volume', {
			environmentId: envIdNum,
			description: 'Pruned unused volumes',
			details: { result }
		});

		return json({ success: true, result });
	} catch (error) {
		console.error('Error pruning volumes:', error);
		return json({ error: 'Failed to prune volumes' }, { status: 500 });
	}
};
