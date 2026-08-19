import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { requireBackups } from '$lib/server/backups/route-guards';
import { getInstanceId } from '$lib/server/backups/identity';

// This install's stable instance id. The snapshots list used to ride it on an
// X-Dockhand-Instance response header, but that list is now job-polled (a proxy would
// abort the sync `restic snapshots` at ~15s) and headers don't survive polling. The
// client fetches the id here once and matches it against each snapshot's
// dockhand:instance= tag to tell own snapshots from foreign orphans (#1351).
/**
 * @openapi
 * summary: This install's stable backup instance id, used to tell own snapshots from foreign orphans
 * description: Requires backups:view; 403 (no permission) and 404 (backup feature disabled) come from the shared requireBackups guard.
 * resp-200: {instanceId:string!}
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);
	const denied = await requireBackups(auth, 'view');
	if (denied) return denied;

	return json({ instanceId: await getInstanceId() });
};
