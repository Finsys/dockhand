import { json } from '@sveltejs/kit';
import { validateSnapshotId } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { requireBackups } from '$lib/server/backups/route-guards';
import { browseSnapshot } from '$lib/server/backups';
import { guardSnapshotEnvAccess } from '$lib/server/backups/route-guards';

/**
 * GET /api/backup/snapshots/{id}/browse - List a directory inside a snapshot
 *
 * @openapi
 * summary: Browse the files and directories at a path inside a snapshot, with a server-authoritative environment access gate
 * path: id:string! Restic snapshot id to browse
 * query: destinationId:integer! Destination holding the snapshot (required)
 * query: path:string Directory path to list inside the snapshot (defaults to "/")
 * query: env:integer Optional environment id for an early enterprise access check; the authoritative gate resolves the snapshot's owning environment server-side
 * resp-200: Returns { entries, path } — the directory entries at the requested path
 * resp-400: Missing/invalid destinationId or an invalid snapshot id
 * resp-403: Permission denied — requires "backups:view", or no access to the snapshot's owning environment
 * resp-500: Failed to browse the snapshot (restic error)
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
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

	try {
		const entries = await browseSnapshot(destinationId, snapshotId, path);
		return json({ entries, path });
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		return json({ error: errorMsg }, { status: 500 });
	}
};
