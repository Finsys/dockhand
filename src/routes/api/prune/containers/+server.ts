import { json } from '@sveltejs/kit';
import { pruneContainers } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { audit } from '$lib/server/audit';
import type { RequestHandler } from './$types';

/**
 * POST /api/prune/containers - Remove all stopped containers
 *
 * @openapi
 * summary: Prune (delete) all stopped containers in the target environment
 * query: env:integer Target environment id; scopes both the prune operation and the permission check (defaults to the local environment) (from GET /api/environments)
 * resp-200: Returns { success: true, result } where result is the Docker container-prune report (deleted container ids, space reclaimed)
 * resp-200-example: {"success":true,"result":{"ContainersDeleted":["abc123","def456"],"SpaceReclaimed":5242880}}
 * resp-403: Permission denied — requires the "remove" permission on containers for the target environment
 * resp-500: Failed to prune containers (Docker error)
 */
export const POST: RequestHandler = async (event) => {
	const { url, cookies } = event;
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('containers', 'remove', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const result = await pruneContainers(envIdNum);

		// Audit log
		await audit(event, 'prune', 'container', {
			environmentId: envIdNum,
			description: 'Pruned stopped containers',
			details: { result }
		});

		return json({ success: true, result });
	} catch (error) {
		console.error('Error pruning containers:', error);
		return json({ error: 'Failed to prune containers' }, { status: 500 });
	}
};
