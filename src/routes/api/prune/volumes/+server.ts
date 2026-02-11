import { json } from '@sveltejs/kit';
import { pruneVolumes } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { audit } from '$lib/server/audit';
import type { RequestHandler } from './$types';

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
