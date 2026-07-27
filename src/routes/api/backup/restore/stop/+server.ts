import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { auditRestore } from '$lib/server/audit';
import { cancelRestore } from '$lib/server/backups';
import { isValidSnapshotId } from '$lib/server/backups/helpers';

/**
 * Cancel a running restore (audit #14). Restore was previously uncancellable —
 * the helper container was never targeted by any stop path. Kills the restore
 * helper for the given snapshotId (or all restore helpers if omitted) so restic
 * exits and runRestore's failure/cleanup path runs.
 */
export const POST: RequestHandler = async (event) => {
	const { request, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('backups', 'manage')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const body = await request.json().catch(() => ({}));
	const snapshotId: string | undefined = body.snapshotId;
	// (audit #57) Validate snapshotId when supplied, matching the restore POST route.
	if (snapshotId !== undefined && !isValidSnapshotId(snapshotId)) {
		return json({ error: 'Invalid snapshotId' }, { status: 400 });
	}
	const environmentId: number | undefined =
		typeof body.environmentId === 'number' ? body.environmentId : undefined;

	// Enforce environment-scoped access when targeting a specific env.
	if (environmentId && auth.isEnterprise && !await auth.canAccessEnvironment(environmentId)) {
		return json({ error: 'Environment access denied' }, { status: 403 });
	}

	try {
		const stopped = await cancelRestore(snapshotId, environmentId);
		await auditRestore(event, snapshotId || 'unknown', environmentId ?? null, { snapshotId, killed: stopped });
		return json({ success: true, stopped });
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return json({ error: msg }, { status: 500 });
	}
};
