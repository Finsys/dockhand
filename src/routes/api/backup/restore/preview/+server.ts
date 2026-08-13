import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { requireBackups } from '$lib/server/backups/route-guards';
import { previewSnapshot, previewRestoreTargets } from '$lib/server/backups';
import { validateSnapshotId } from '$lib/server/docker-validation';
import { guardSnapshotEnvAccess } from '$lib/server/backups/route-guards';

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
