import { json } from '@sveltejs/kit';
import { validateSnapshotId } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { requireBackups, guardSnapshotEnvAccess } from '$lib/server/backups/route-guards';
import { auditBackup } from '$lib/server/audit';
import { getBackupDestination } from '$lib/server/db';
import { forgetSnapshots } from '$lib/server/backups';

/**
 * POST /api/backup/snapshots/batch-delete - Forget many snapshots from ONE destination
 * in a single restic forget --prune (prunes once). Each id is ownership- and (enterprise)
 * environment-access-checked; ids that fail a check are skipped, never forgotten.
 *
 * @openapi
 * summary: Forget and prune several snapshots from one destination in a single restic forget --prune, with per-snapshot ownership and environment access gates
 * description: Permission denial (403, "backups:manage") is produced by the shared requireBackups route guard. Per-snapshot ownership/environment failures are skipped (returned in `skipped`), not 403d.
 * body: {destinationId:integer!, snapshotIds:array<string>!}
 * body-example: {"destinationId":3,"snapshotIds":["1a2b3c4d","5e6f7a8b"]}
 * resp-200: Returns { success: true, deleted: string[], skipped: string[] } - deleted were forgotten, skipped were not owned or not accessible
 * resp-200-example: {"success":true,"deleted":["1a2b3c4d"],"skipped":["5e6f7a8b"]}
 * resp-400: Missing/invalid destinationId, empty snapshotIds, or an invalid snapshot id
 * resp-500: Failed to forget the snapshots (restic error)
 */
export const POST: RequestHandler = async (event) => {
	const { request, cookies } = event;
	const auth = await authorize(cookies);
	const rbacDenied = await requireBackups(auth, 'manage');
	if (rbacDenied) return rbacDenied;

	const body = await request.json().catch(() => ({})) as { destinationId?: number; snapshotIds?: string[] };
	const destinationId = Number(body.destinationId);
	if (!Number.isInteger(destinationId) || destinationId <= 0) {
		return json({ error: 'destinationId is required' }, { status: 400 });
	}
	const snapshotIds = Array.isArray(body.snapshotIds) ? body.snapshotIds : [];
	if (snapshotIds.length === 0) {
		return json({ error: 'snapshotIds must be a non-empty array' }, { status: 400 });
	}
	for (const id of snapshotIds) {
		const invalid = validateSnapshotId(id);
		if (invalid) return invalid;
	}

	// Server-authoritative env gate per snapshot (same as the single-delete route): resolve
	// each snapshot's owning env from its own tag and drop the ones the caller can't access.
	// In enterprise this resolve lists the snapshot instance-scoped, which ALSO proves this
	// instance owns it, so the accessible ids are already vetted (ownership + env) and are
	// forgotten preVetted - no second per-id ownership listing. In free edition the guard is
	// a no-op (no listing), so the engine must do the ownership check itself (preVetted=false).
	const accessible: string[] = [];
	const skippedByEnv: string[] = [];
	for (const id of snapshotIds) {
		const denied = await guardSnapshotEnvAccess(auth, destinationId, id);
		if (denied) skippedByEnv.push(id);
		else accessible.push(id);
	}

	try {
		const result = accessible.length > 0
			? await forgetSnapshots(destinationId, accessible, { preVetted: auth.isEnterprise })
			: { deleted: [], skipped: [] as string[] };
		const skipped = [...result.skipped, ...skippedByEnv];
		const dest = await getBackupDestination(destinationId);
		await auditBackup(event, 'delete', dest?.name ?? `destination#${destinationId}`, null, {
			destinationId, kind: 'snapshot', deleted: result.deleted, skipped, ...(result.error ? { failed: true, reason: result.error } : {})
		});
		if (result.error) {
			return json({ error: result.error, deleted: result.deleted, skipped }, { status: 500 });
		}
		return json({ success: true, deleted: result.deleted, skipped });
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		return json({ error: errorMsg }, { status: 500 });
	}
};
