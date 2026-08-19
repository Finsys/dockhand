import { json } from '@sveltejs/kit';
import { pruneNetworks } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { audit } from '$lib/server/audit';
import type { RequestHandler } from './$types';

/**
 * POST /api/prune/networks - Remove all unused networks
 *
 * @openapi
 * summary: Prune (delete) all unused Docker networks in the target environment
 * query: env:integer Target environment id; scopes both the prune operation and the permission check (defaults to the local environment) (from GET /api/environments)
 * resp-200: Returns { success: true, result } where result is the Docker network-prune report (deleted network names)
 * resp-200-example: {"success":true,"result":{"NetworksDeleted":["bridge-old","test-net"]}}
 * resp-403: Permission denied — requires the "remove" permission on networks for the target environment
 * resp-500: Failed to prune networks (Docker error)
 */
export const POST: RequestHandler = async (event) => {
	const { url, cookies } = event;
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('networks', 'remove', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const result = await pruneNetworks(envIdNum);

		// Audit log
		await audit(event, 'prune', 'network', {
			environmentId: envIdNum,
			description: 'Pruned unused networks',
			details: { result }
		});

		return json({ success: true, result });
	} catch (error) {
		console.error('Error pruning networks:', error);
		return json({ error: 'Failed to prune networks' }, { status: 500 });
	}
};
