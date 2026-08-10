import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { requireBackups } from '$lib/server/backups/route-guards';
import { auditBackupDestination } from '$lib/server/audit';
import { getBackupDestination } from '$lib/server/db';
import { rotateDestinationPassword } from '$lib/server/backups';

/**
 * Rotate the restic repository password for a destination.
 *
 * @openapi
 * summary: Rotate the restic repository password for a destination and persist the new password
 * description: Permission denial (403, "backups:manage") is produced by the shared requireBackups route guard.
 * path: id:integer! Backup destination id (from GET /api/backup/destinations)
 * body: {currentPassword:string!, newPassword:string!}
 * body-example: {"currentPassword":"***","newPassword":"***"}
 * resp-200: Returns { success: true } once the password is rotated and the database is updated
 * resp-200-example: {"success":true}
 * resp-400: Invalid input — invalid id, missing passwords, or the current password is incorrect
 * resp-404: Destination not found
 * resp-409: restic rotated the key but the database write failed (manual recovery needed; the response includes dbOutOfSync:true)
 * resp-500: restic call failed for an unrelated reason
 */
export const POST: RequestHandler = async (event) => {
	const { params, request, cookies } = event;
	const auth = await authorize(cookies);
	const denied = await requireBackups(auth, 'manage');
	if (denied) return denied;

	const id = parseInt(params.id);
	if (isNaN(id)) return json({ error: 'Invalid ID' }, { status: 400 });

	const body = await request.json().catch(() => ({}));
	const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
	const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

	if (!currentPassword || !newPassword) {
		return json({ error: 'currentPassword and newPassword are required' }, { status: 400 });
	}

	const dest = await getBackupDestination(id);
	if (!dest) return json({ error: 'Destination not found' }, { status: 404 });

	const result = await rotateDestinationPassword(id, currentPassword, newPassword);
	if (!result.ok) {
		// Audit the failed attempt — useful signal for spotting wrong-password
		// probes against destinations.
		await auditBackupDestination(event, 'update', id, dest.name, {
			action: 'rotate-key',
			success: false,
			error: result.error,
			dbOutOfSync: result.dbOutOfSync ?? false
		});
		if (result.dbOutOfSync) {
			return json({ error: result.error, dbOutOfSync: true }, { status: 409 });
		}
		// Restic reports an incorrect current password as "wrong password" or
		// "no key found" — surface a clearer 400 so the UI can say the current
		// password is incorrect rather than a generic failure.
		if (/wrong password|no key found/i.test(result.error)) {
			return json({ error: 'Current password incorrect' }, { status: 400 });
		}
		if (result.error.toLowerCase().includes('does not match') || result.error.toLowerCase().includes('must')) {
			return json({ error: result.error }, { status: 400 });
		}
		return json({ error: result.error }, { status: 500 });
	}

	await auditBackupDestination(event, 'update', id, dest.name, { action: 'rotate-key', success: true });
	return json({ success: true });
};
