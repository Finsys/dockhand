import { json } from '@sveltejs/kit';
import { pruneContainers } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { audit } from '$lib/server/audit';
import type { RequestHandler } from './$types';

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
