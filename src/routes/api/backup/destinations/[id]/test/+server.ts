import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import {
	getBackupDestination,
	updateBackupDestinationTestStatus
} from '$lib/server/db';
import { testRepository } from '$lib/server/backups';

export const POST: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('backups', 'manage')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const id = parseInt(params.id);
	if (isNaN(id)) return json({ error: 'Invalid ID' }, { status: 400 });

	const destination = await getBackupDestination(id);
	if (!destination) return json({ error: 'Destination not found' }, { status: 404 });

	const result = await testRepository(id);
	if (result.ok) {
		await updateBackupDestinationTestStatus(id, 'success');
		return json({ success: true, status: 'success' });
	}
	if (result.needsInit) {
		await updateBackupDestinationTestStatus(id, 'needs_init', result.error);
		return json({ success: false, status: 'needs_init', error: result.error });
	}
	await updateBackupDestinationTestStatus(id, 'failed', result.error);
	return json({ success: false, status: 'failed', error: result.error });
};
