import { json } from '@sveltejs/kit';
import { validateSnapshotId } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { requireBackups } from '$lib/server/backups/route-guards';
import { browseSnapshot } from '$lib/server/backups';
import { guardSnapshotEnvAccess } from '$lib/server/backups/route-guards';
import { jobResult } from '$lib/server/sse';

/**
 * @openapi
 * summary: List directory entries at a path inside a snapshot (job-polled)
 * description: Job-polled so a proxy can't abort the restic read at ~15s.
 * path: id:string The restic snapshot id
 * query: destinationId:integer Destination the snapshot lives in
 * query: path:string Directory path inside the snapshot to list
 * query: env:integer Environment context for access checks
 * resp-400: Missing/invalid destinationId
 * resp-403: Permission denied (needs backups:view) or environment access denied
 */
export const GET: RequestHandler = async ({ params, url, cookies, request }) => {
	const auth = await authorize(cookies);
	const denied = await requireBackups(auth, 'view');
	if (denied) return denied;

	const snapshotId = params.id;
	const invalidSnap = validateSnapshotId(snapshotId);
	if (invalidSnap) return invalidSnap;

	const destIdParam = url.searchParams.get('destinationId');
	if (!destIdParam) return json({ error: 'destinationId parameter is required' }, { status: 400 });

	const destinationId = parseInt(destIdParam);
	if (isNaN(destinationId)) return json({ error: 'Invalid destinationId' }, { status: 400 });

	const path = url.searchParams.get('path') || '/';

	const envParam = url.searchParams.get('env');
	const envId = envParam ? parseInt(envParam) : undefined;

	// (HIGH #8) Server-authoritative env access: resolve the snapshot's OWNING
	// env from its tag and enforce access — the client-supplied `env` param is no
	// longer trusted as the source of truth (omitting it previously skipped the
	// check entirely). Kept below is the caller-param check as an extra early gate.
	const envDenied = await guardSnapshotEnvAccess(auth, destinationId, snapshotId);
	if (envDenied) return envDenied;

	// Additional check on any explicitly-supplied env param (enterprise RBAC).
	if (envId !== undefined && !isNaN(envId) && auth.isEnterprise && !await auth.canAccessEnvironment(envId)) {
		return json({ error: 'Environment access denied' }, { status: 403 });
	}

	// Job-polling: `restic ls` behind a reverse proxy would abort at ~15s and SIGTERM restic
	// (surfacing a misleading "wrong password / signal terminated"). Return {jobId} at once.
	return jobResult(request, async () => {
		const entries = await browseSnapshot(destinationId, snapshotId, path);
		return { entries, path };
	});
};
