import { json } from '@sveltejs/kit';
import { pruneAll } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { audit } from '$lib/server/audit';
import type { RequestHandler } from './$types';

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
