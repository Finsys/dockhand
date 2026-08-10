import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { requireBackups } from '$lib/server/backups/route-guards';
import { diffSnapshots } from '$lib/server/backups';
import { guardSnapshotEnvAccess } from '$lib/server/backups/route-guards';
import { validateSnapshotId } from '$lib/server/docker-validation';

/**
 * GET /api/backup/snapshots/diff - Diff two snapshots
 *
 * @openapi
 * summary: Compute the file-level difference between two snapshots in the same destination, gating access on both snapshots' owning environments
 * description: Permission ("backups:view") and environment-access denials (403) are produced by the shared requireBackups/guardSnapshotEnvAccess route guards.
 * query: destinationId:integer! Destination holding both snapshots (required) (from GET /api/backup/destinations)
 * query: snapshotA:string! First (base) restic snapshot id (required)
 * query: snapshotB:string! Second (compared) restic snapshot id (required)
 * resp-200: The diff result object (added/removed/changed entries between the two snapshots)
 * resp-400: Missing required params (destinationId, snapshotA, snapshotB) or an invalid snapshot id
 * resp-500: Failed to diff the snapshots (restic error)
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);
	const denied = await requireBackups(auth, 'view');
	if (denied) return denied;

	const destId = url.searchParams.get('destinationId');
	const snapA = url.searchParams.get('snapshotA');
	const snapB = url.searchParams.get('snapshotB');

	if (!destId || !snapA || !snapB) {
		return json({ error: 'Missing required params: destinationId, snapshotA, snapshotB' }, { status: 400 });
	}

	const invalidA = validateSnapshotId(snapA);
	if (invalidA) return invalidA;
	const invalidB = validateSnapshotId(snapB);
	if (invalidB) return invalidB;

	// (HIGH #8) Enforce per-environment access on BOTH snapshots' owning env.
	const destinationId = parseInt(destId);
	const deniedA = await guardSnapshotEnvAccess(auth, destinationId, snapA);
	if (deniedA) return deniedA;
	const deniedB = await guardSnapshotEnvAccess(auth, destinationId, snapB);
	if (deniedB) return deniedB;

	try {
		const result = await diffSnapshots(destinationId, snapA, snapB);
		return json(result);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return json({ error: msg }, { status: 500 });
	}
};
