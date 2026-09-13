import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { requireBackups } from '$lib/server/backups/route-guards';
import {
	getBackupDestination,
	updateBackupDestinationTestStatus
} from '$lib/server/db';
import { testRepository } from '$lib/server/backups';

/**
 * POST /api/backup/destinations/{id}/test - Test a saved backup destination
 *
 * @openapi
 * summary: Test connectivity to a saved backup destination's repository and update its stored test status
 * description: Permission denial (403, "backups:manage") is produced by the shared requireBackups route guard.
 * path: id:integer! Backup destination id (from GET /api/backup/destinations)
 * resp-200: Test result — { success: true, status: "success" } when reachable, or { success: false, status: "needs_init" | "failed", error } otherwise
 * resp-200-example: {"success":true,"status":"success"}
 * resp-400: Invalid id (not a number)
 * resp-404: Destination not found
 */
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
