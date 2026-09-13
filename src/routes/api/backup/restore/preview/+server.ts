import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { requireBackups } from '$lib/server/backups/route-guards';
import { previewSnapshot, previewRestoreTargets } from '$lib/server/backups';
import { validateSnapshotId } from '$lib/server/docker-validation';
import { guardSnapshotEnvAccess } from '$lib/server/backups/route-guards';
import { jobResult } from '$lib/server/sse';

/**
 * @openapi
 * summary: Preview what a restore would write (resolved targets + volume/stack contents)
 * description: With includeTargets it also resolves the concrete restore targets (host paths / volumes); without it, returns the metadata-only preview the initial modal load relies on.
 * body: {destinationId:integer!, snapshotId:string!, includeTargets:boolean, targetEnvId:integer, environmentId:integer, mode:string, targetType:string, targetName:string, targetPath:string, volumeDestinations:object, volumes:array<string>, skipStackFiles:boolean, mergeStackFiles:boolean}
 * resp-200: object
 * resp-200-desc: The snapshot preview, optionally with a resolved targets list
 * resp-400: Missing required fields (destinationId, snapshotId)
 * resp-403: Permission denied (needs backups:view) or access denied to the target environment
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	// Read-only: restic ls/dump + host probes, writes nothing (like snapshots dump/browse),
	// so it gates on view. The actual restore (restore/+server.ts) still needs manage.
	const rbacDenied = await requireBackups(auth, 'view');
	if (rbacDenied) return rbacDenied;

	const body = await request.json();

	if (!body.destinationId || !body.snapshotId) {
		return json({ error: 'Missing required fields: destinationId, snapshotId' }, { status: 400 });
	}
	const invalidSnap = validateSnapshotId(body.snapshotId);
	if (invalidSnap) return invalidSnap;

	if (body.environmentId && auth.isEnterprise && !await auth.canAccessEnvironment(body.environmentId)) {
		return json({ error: 'Access denied to target environment' }, { status: 403 });
	}
	// Gate on the snapshot's owning environment (server-resolved, fail-closed).
	const denied = await guardSnapshotEnvAccess(auth, body.destinationId, body.snapshotId);
	if (denied) return denied;

	// Job-polling: the preview runs restic (verify-ownership + ls/dump) and, with a mode,
	// per-volume probe helpers - all slow enough that a reverse proxy would abort the sync
	// request at ~15s and SIGTERM the restic mid-op (the "wrong password / signal terminated"
	// red herrings). Returning {jobId} immediately keeps the connection alive; the client polls.
	return jobResult(request, async () => {
		const access = { isEnterprise: auth.isEnterprise, canAccessEnvironment: (id: number) => auth.canAccessEnvironment(id) };
		const preview = await previewSnapshot(body.destinationId, body.snapshotId, access);
		// When the caller supplies a restore mode, ALSO resolve the exact on-disk targets and probe
		// them on the target host (the same computation the real restore uses). Absent `mode` keeps
		// the metadata-only response the initial modal load and existing callers rely on.
		if (body.mode === 'in-place' || body.mode === 'new-location') {
			const targets = await previewRestoreTargets(body.destinationId, body.snapshotId, {
				mode: body.mode,
				environmentId: body.environmentId ?? null,
				targetType: body.targetType,
				targetName: body.targetName ?? null,
				targetPath: body.targetPath ?? null,
				volumeDestinations: body.volumeDestinations,
				skipStackFiles: body.skipStackFiles,
				mergeStackFiles: body.mergeStackFiles,
				volumes: body.volumes,
			}, access);
			return { ...preview, targets };
		}
		return preview;
	});
};
