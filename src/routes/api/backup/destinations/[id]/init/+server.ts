import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { requireBackups } from '$lib/server/backups/route-guards';
import { auditBackupDestination } from '$lib/server/audit';
import { getBackupDestination, updateBackupDestinationTestStatus } from '$lib/server/db';
import { initRepository } from '$lib/server/backups';

/**
 * POST /api/backup/destinations/{id}/init - Initialize the restic repository
 *
 * @openapi
 * summary: Initialize the restic repository for a destination and record the resulting test status
 * description: Permission denial (403, "backups:manage") is produced by the shared requireBackups route guard.
 * path: id:integer! Backup destination id (from GET /api/backup/destinations)
 * resp-200: Returns { success: true, message } when the repository is initialized
 * resp-200-example: {"success":true,"message":"Repository initialized"}
 * resp-400: Invalid id (not a number)
 * resp-404: Destination not found
 * resp-500: Repository initialization failed; returns { success: false, error }
 */
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
