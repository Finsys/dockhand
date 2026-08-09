import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { requireBackups } from '$lib/server/backups/route-guards';
import { auditBackupDestination } from '$lib/server/audit';
import { getBackupDestination, updateBackupDestinationTestStatus } from '$lib/server/db';
import { initRepository } from '$lib/server/backups';

export const POST: RequestHandler = async (event) => {
	const { params, cookies } = event;
	const auth = await authorize(cookies);
	const denied = await requireBackups(auth, 'manage');
	if (denied) return denied;

	const id = parseInt(params.id);
	if (isNaN(id)) return json({ error: 'Invalid ID' }, { status: 400 });

	const dest = await getBackupDestination(id);
	if (!dest) return json({ error: 'Destination not found' }, { status: 404 });

	try {
		await initRepository(id);
		await updateBackupDestinationTestStatus(id, 'success');
		// Repo init is a state change on the destination, treat it as an
		// 'update' so it's distinguishable from create-destination events.
		await auditBackupDestination(event, 'update', id, dest.name, { action: 'init', status: 'success' });
		return json({ success: true, message: 'Repository initialized' });
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		await updateBackupDestinationTestStatus(id, 'failed', msg);
		await auditBackupDestination(event, 'update', id, dest.name, { action: 'init', status: 'failed', error: msg });
		return json({ success: false, error: msg }, { status: 500 });
	}
};
