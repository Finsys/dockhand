import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { requireBackups } from '$lib/server/backups/route-guards';
import {
	getBackupDestination,
	updateBackupDestinationTestStatus
} from '$lib/server/db';
import { testRepository } from '$lib/server/backups';

export const POST: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	const denied = await requireBackups(auth, 'manage');
	if (denied) return denied;

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
