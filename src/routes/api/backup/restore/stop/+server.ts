import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { requireBackups } from '$lib/server/backups/route-guards';
import { auditRestore } from '$lib/server/audit';
import { cancelRestore } from '$lib/server/backups';
import { isValidSnapshotId } from '$lib/server/backups/helpers';

/**
 * Cancel a running restore (audit #14). Restore was previously uncancellable —
 * the helper container was never targeted by any stop path. Kills the restore
 * helper for the given snapshotId (or all restore helpers if omitted) so restic
 * exits and runRestore's failure/cleanup path runs.
 *
 * @openapi
 * summary: Cancel a running restore — kills the restore helper for a given snapshotId, or all restore helpers when snapshotId is omitted
 * description: snapshotId from GET /api/backup/snapshots. environmentId from GET /api/environments.
 * body: {snapshotId:string, environmentId:integer}
 * body-example: {"snapshotId":"a1b2c3d4"}
 * resp-200: Returns { success: true, stopped } where "stopped" indicates whether a running restore helper was actually killed
 * resp-200-example: {"success":true,"stopped":true}
 * resp-400: Invalid snapshotId
 * resp-403: Permission denied — requires "backups:manage", or no access to the targeted environment
 * resp-500: Failed to cancel the restore (internal error)
 */
export const POST: RequestHandler = async (event) => {
	const { request, cookies } = event;
	const auth = await authorize(cookies);
	const denied = await requireBackups(auth, 'manage');
	if (denied) return denied;

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
