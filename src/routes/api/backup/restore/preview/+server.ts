import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { previewSnapshot } from '$lib/server/backups';
import { validateSnapshotId } from '$lib/server/docker-validation';
import { guardSnapshotEnvAccess } from '$lib/server/backups/route-guards';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('backups', 'manage')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

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
		return json(preview);
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		return json({ error: errorMsg }, { status: 500 });
	}
};
