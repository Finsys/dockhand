import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { runRestore } from '$lib/server/backups';
import { validateRestoreRequest, type RestoreMode } from '$lib/server/backups/validate';
import { createJobResponse } from '$lib/server/sse';
import { auditRestore } from '$lib/server/audit';
import { guardSnapshotEnvAccess } from '$lib/server/backups/route-guards';

export const POST: RequestHandler = async (event) => {
	const { request, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('backups', 'manage')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const body = await request.json();
	const mode: RestoreMode = body.mode === 'in-place' ? 'in-place' : 'new-location';
	// Optional post-restore action. In-place: start/recreate/redeploy/none.
	// New-location clone: recreate/redeploy/none bring the target up on the target env.
	const postRestore = ['start', 'recreate', 'redeploy', 'none'].includes(body.postRestore) ? body.postRestore : undefined;
	// New-location clone: per-volume destinations on the target env.
	const volumeDestinations = Array.isArray(body.volumeDestinations) ? body.volumeDestinations : undefined;

	// Authorization gates run BEFORE request validation, so an unauthorized caller
	// never learns anything about the request shape.
	// Target environment access (enterprise RBAC).
	if (body.environmentId && auth.isEnterprise && !await auth.canAccessEnvironment(body.environmentId)) {
		return json({ error: 'Access denied to target environment' }, { status: 403 });
	}
	// Gate on the SNAPSHOT's owning environment too (server-resolved, fail-closed).
	const denied = await guardSnapshotEnvAccess(auth, body.destinationId, body.snapshotId);
	if (denied) return denied;

	// Validate the request shape (all errors at once). Enforces the destructive-
	// intent rule: an in-place restore requires explicit confirmation.
	const check = validateRestoreRequest({
		destinationId: body.destinationId,
		snapshotId: body.snapshotId,
		volumes: body.volumes,
		mode,
		confirmOverwrite: body.confirmOverwrite,
		targetPath: body.targetPath,
		stackName: body.targetName,
		environmentId: body.environmentId,
		postRestore,
		targetName: body.targetName,
		volumeDestinations,
	});
	if (!check.ok) {
		return json({ error: 'Invalid restore request', issues: check.issues }, { status: 400 });
	}

	await auditRestore(event, body.targetName || 'unknown', body.environmentId, { snapshotId: body.snapshotId, destinationId: body.destinationId, mode });

	// The service also enforces snapshot ownership; thread the caller's access
	// context so the enterprise environment gate is applied there too.
	const access = { isEnterprise: auth.isEnterprise, canAccessEnvironment: (id: number) => auth.canAccessEnvironment(id) };

	return createJobResponse(async (send) => {
		const result = await runRestore(
			{
				destinationId: body.destinationId,
				snapshotId: body.snapshotId,
				mode,
				targetType: body.targetType === 'stack' ? 'stack' : 'container',
				volumes: body.volumes ?? [],
				environmentId: body.environmentId ?? null,
				confirmOverwrite: body.confirmOverwrite === true,
				targetPath: body.targetPath ?? null,
				targetName: body.targetName ?? null,
				postRestore,
				volumeDestinations,
			},
			access,
			// Stream progress to the client (the restore modal's log). Without this the
			// modal showed "0 lines" then jumped straight to the result — restore's
			// op.progress lines were only persisted to the DB, never streamed.
			(status, message) => send('progress', { status, message }),
		);

		send('result', result);

		if (result.status === 'error') {
			throw new Error(result.error || 'Restore failed');
		}
	}, request);
};
