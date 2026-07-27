import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { diffSnapshots } from '$lib/server/backups';
import { guardSnapshotEnvAccess } from '$lib/server/backups/route-guards';
import { validateSnapshotId } from '$lib/server/docker-validation';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('backups', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

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
