import { json } from '@sveltejs/kit';
import { pruneAll } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { audit } from '$lib/server/audit';
import type { RequestHandler } from './$types';

/**
 * POST /api/prune/all - Prune every unused Docker resource type at once
 *
 * @openapi
 * summary: Prune all unused Docker resources (containers, images, volumes and networks) in a single operation
 * query: env:integer Target environment id; scopes both the prune operation and the permission check (defaults to the local environment) (from GET /api/environments)
 * resp-200: Returns { success: true, result } where result is the aggregated Docker prune report (space reclaimed, items deleted)
 * resp-200-example: {"success":true,"result":{"ContainersDeleted":["abc123"],"ImagesDeleted":[],"VolumesDeleted":[],"NetworksDeleted":[],"SpaceReclaimed":10485760}}
 * resp-403: Permission denied — requires the "remove" permission on containers, images, volumes AND networks for the target environment
 * resp-500: Failed to prune the system (Docker error); the message is returned in "details"
 */
export const POST: RequestHandler = async (event) => {
	const { url, cookies } = event;
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Prune all requires remove permission on all resource types (with environment context)
	if (auth.authEnabled && (!await auth.can('containers', 'remove', envIdNum) || !await auth.can('images', 'remove', envIdNum) || !await auth.can('volumes', 'remove', envIdNum) || !await auth.can('networks', 'remove', envIdNum))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const result = await pruneAll(envIdNum);

		// Audit log - single entry for prune all operation
		await audit(event, 'prune', 'settings', {
			environmentId: envIdNum,
			entityName: 'system',
			description: 'Pruned all unused Docker resources',
			details: { result }
		});

		return json({ success: true, result });
	} catch (error: any) {
		console.error('Error pruning all:', error?.message || error, error?.stack);
		return json({ error: 'Failed to prune system', details: error?.message }, { status: 500 });
	}
};
