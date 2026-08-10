import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { requireBackups } from '$lib/server/backups/route-guards';
import { previewSnapshot, previewRestoreTargets } from '$lib/server/backups';
import { validateSnapshotId } from '$lib/server/docker-validation';
import { guardSnapshotEnvAccess } from '$lib/server/backups/route-guards';

/**
 * POST /api/backup/restore/preview - Preview a snapshot's contents before restoring
 *
 * @openapi
 * summary: Preview the contents of a snapshot (volumes, metadata) before running a restore
 * description: destinationId from GET /api/backup/destinations. snapshotId from GET /api/backup/snapshots. environmentId from GET /api/environments.
 * body: {destinationId:integer!, snapshotId:string!, environmentId:integer}
 * body-example: {"destinationId":3,"snapshotId":"a1b2c3d4"}
 * resp-200: The snapshot preview object (contents/metadata used to plan a restore)
 * resp-400: Invalid input — missing destinationId/snapshotId or an invalid snapshot id
 * resp-403: Permission denied — requires "backups:manage", or no access to the target or snapshot-owning environment
 * resp-500: Failed to build the preview (restic error)
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	const rbacDenied = await requireBackups(auth, 'manage');
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

	try {
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
			return json({ ...preview, targets });
		}
		return json(preview);
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		return json({ error: errorMsg }, { status: 500 });
	}
};
