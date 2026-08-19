import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { requireBackups } from '$lib/server/backups/route-guards';
import { diffSnapshots } from '$lib/server/backups';
import { guardSnapshotEnvAccess } from '$lib/server/backups/route-guards';
import { validateSnapshotId } from '$lib/server/docker-validation';
import { jobResult } from '$lib/server/sse';

/**
 * @openapi
 * summary: Diff two snapshots' file trees (added/changed/removed) - job-polled
 * description: Job-polled so a proxy can't abort the restic read at ~15s.
 * query: destinationId:integer Destination both snapshots live in
 * query: snapshotA:string The baseline snapshot id
 * query: snapshotB:string The snapshot to compare against the baseline
 * resp-400: Missing destinationId, snapshotA, or snapshotB
 */
export const GET: RequestHandler = async ({ url, cookies, request }) => {
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

	// Job-polling: `restic diff` runs two restic reads a proxy would abort at ~15s.
	return jobResult(request, () => diffSnapshots(destinationId, snapA, snapB));
};
