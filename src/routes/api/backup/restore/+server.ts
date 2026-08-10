import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { requireBackups } from '$lib/server/backups/route-guards';
import { runRestore } from '$lib/server/backups';
import { validateRestoreRequest, type RestoreMode } from '$lib/server/backups/validate';
import { createJobResponse } from '$lib/server/sse';
import { auditRestore } from '$lib/server/audit';
import { guardSnapshotEnvAccess } from '$lib/server/backups/route-guards';

/**
 * POST /api/backup/restore - Restore a snapshot (streamed job)
 *
 * @openapi
 * summary: Restore a backup snapshot in-place or to a new location, streaming progress as a Server-Sent Events job
 * description: Returns a text/event-stream that emits `progress` events and a final `result` event. An in-place restore is destructive and requires confirmOverwrite:true. Authorization and snapshot-environment access are checked before the request shape is validated. destinationId from GET /api/backup/destinations. snapshotId from GET /api/backup/snapshots. environmentId from GET /api/environments.
 * body: {destinationId:integer!, snapshotId:string!, mode:string, targetType:string, volumes:array<string>, environmentId:integer, confirmOverwrite:boolean, targetPath:string, targetName:string, postRestore:string, volumeDestinations:array<{}>}
 * body-example: {"destinationId":3,"snapshotId":"a1b2c3d4","mode":"new-location","targetType":"container","targetName":"nextcloud-restored","environmentId":1,"confirmOverwrite":false}
 * resp-200: Server-Sent Events stream of progress and a final result event (status "success" or "error")
 * resp-400: Invalid restore request; the response "issues" array lists the validation problems
 * resp-403: Permission denied — requires "backups:manage", or no access to the target or snapshot-owning environment
 */
export const POST: RequestHandler = async (event) => {
	const { request, cookies } = event;
	const auth = await authorize(cookies);
	const rbacDenied = await requireBackups(auth, 'manage');
	if (rbacDenied) return rbacDenied;

	const body = await request.json();
	const mode: RestoreMode = body.mode === 'in-place' ? 'in-place' : 'new-location';
	// Optional post-restore action. In-place: start/recreate/redeploy/none.
	// New-location clone: recreate/redeploy/none bring the target up on the target env.
	const postRestore = ['start', 'recreate', 'redeploy', 'none'].includes(body.postRestore) ? body.postRestore : undefined;
	// New-location clone: per-volume destinations on the target env.
	const volumeDestinations = Array.isArray(body.volumeDestinations) ? body.volumeDestinations : undefined;
	// Stack restore: reproduce the stack's secrets carried in the snapshot (default on).
	// The client sends false to bring the stack up without them. Only a stack redeploy
	// consumes this; container restores ignore it.
	const restoreSecrets = body.restoreSecrets !== false;
	// New-location STACK restore: skip the captured compose/.env (data-only restore),
	// and/or ADOPT the restored stack into Dockhand afterwards (opt-in). Both default off.
	const skipStackFiles = body.skipStackFiles === true;

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
				restoreSecrets,
				skipStackFiles,
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
