import { json } from '@sveltejs/kit';
import { validateSnapshotId } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { browseSnapshot } from '$lib/server/backups';
import { guardSnapshotEnvAccess } from '$lib/server/backups/route-guards';

export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('backups', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

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
