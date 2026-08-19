import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { auditBackup } from '$lib/server/audit';
import {
	updateBackupConfig,
	deleteBackupConfig
} from '$lib/server/db';
import { registerSchedule, unregisterSchedule, isValidCron } from '$lib/server/scheduler';
import { isBackupRunning } from '$lib/server/backups';
import { validateRetention, retentionToStore, resolveEnabledOnScheduleChange } from '$lib/server/backups/helpers';
import { requireBackups, loadConfigGateEnv } from '$lib/server/backups/route-guards';

/**
 * GET /api/backup/configs/{id} - Get a single backup configuration
 *
 * @openapi
 * summary: Fetch a single backup configuration by id, enforcing environment-scoped access
 * description: Permission ("backups:view") and environment-access denials (403) and not-found (404) are produced by the shared route guards.
 * path: id:integer! Backup configuration id (from GET /api/backup/configs)
 * resp-200: The backup configuration object
 */
export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	const denied = await requireBackups(auth, 'view');
	if (denied) return denied;

	// (audit LOW #41) Env-scope the single-config read too — the LIST endpoint
	// already filters, but this direct fetch leaked a config for an off-limits env.
	const gated = await loadConfigGateEnv(params.id, auth);
	if ('response' in gated) return gated.response;

	return json(gated.config);
};

/**
 * PUT /api/backup/configs/{id} - Update a backup configuration
 *
 * @openapi
 * summary: Update a backup configuration and re-register or remove its cron schedule accordingly
 * description: Permission ("backups:manage") and environment-access denials (403) and not-found (404) are produced by the shared route guards. The environment is fixed at creation and cannot be changed here. destinationId from GET /api/backup/destinations.
 * path: id:integer! Backup configuration id (from GET /api/backup/configs)
 * body: {destinationId:integer, enabled:boolean, allVolumes:boolean, selectedVolumes:array<string>, stopBeforeBackup:boolean, schedule:string, retention:{keepLast:integer, keepDaily:integer, keepWeekly:integer, keepMonthly:integer, keepYearly:integer}, options:{}, tags:array<string>}
 * body-example: {"schedule":"0 4 * * *","enabled":true,"stopBeforeBackup":true,"retention":{"keepDaily":14}}
 * resp-200: The updated backup configuration object
 * resp-400: Invalid input — invalid cron expression, invalid retention, or a local repository paired with a remote environment
 * resp-409: Cannot change the destination while a backup is running for this config
 * resp-500: Update failed (persistence error)
 */
export const PUT: RequestHandler = async (event) => {
	const { params, request, cookies } = event;
	const auth = await authorize(cookies);
	const denied = await requireBackups(auth, 'manage');
	if (denied) return denied;

	// Environment access check (enterprise RBAC). Config's env is fixed at creation.
	const gated = await loadConfigGateEnv(params.id, auth);
	if ('response' in gated) return gated.response;
	const existing = gated.config;
	const id = existing.id;

	const body = await request.json();

	// Validate cron schedule if provided (audit #7)
	if (typeof body.schedule === 'string' && body.schedule.trim() && !isValidCron(body.schedule.trim())) {
		return json({ error: `Invalid cron expression: ${body.schedule}` }, { status: 400 });
	}

	// Validate retention keep-* values before persisting (audit medium #13).
	const retentionCheck = validateRetention(body.retention);
	if (!retentionCheck.ok) {
		return json({ error: `Invalid retention: ${retentionCheck.reason}` }, { status: 400 });
	}

	// (audit #56) Changing the destination while a backup is in flight would leave
	// the running backup on the OLD destination's lock while the schedule re-arms
	// under the new one — refuse the destination change until the run finishes.
	if (body.destinationId !== undefined && body.destinationId !== existing.destinationId && isBackupRunning(id)) {
		return json({ error: 'Cannot change the destination while a backup is running for this config' }, { status: 409 });
	}

	// A local-path repo is allowed on any env; a wrong-host mount fails loud via
	// the helper's localRepoGuard at run time.

	// Auto-enable a config that transitions from manual (no schedule) to scheduled
	// (a real cron) — otherwise a paused run-once config that the user edits to add a
	// schedule stays paused, forcing a manual un-pause. See resolveEnabledOnScheduleChange.
	const resolvedEnabled = resolveEnabledOnScheduleChange({
		requestedEnabled: body.enabled,
		existingSchedule: existing.schedule,
		newSchedule: body.schedule ?? existing.schedule
	});

	try {
		const updated = await updateBackupConfig(id, {
			destinationId: body.destinationId,
			enabled: resolvedEnabled,
			allVolumes: body.allVolumes,
			selectedVolumes: body.selectedVolumes ? JSON.stringify(body.selectedVolumes) : body.selectedVolumes,
			stopBeforeBackup: body.stopBeforeBackup,
			schedule: body.schedule,
			// Apply the default scheduled retention the same way create does, so a
			// config edited to add a schedule with no explicit retention doesn't end
			// up with pruning disabled and an unbounded-growth repo. Uses the effective
			// schedule (the incoming one, or the existing one if unchanged).
			retention: retentionToStore(body.retention, body.schedule ?? existing.schedule),
			options: body.options ? JSON.stringify(body.options) : body.options,
			tags: body.tags ? JSON.stringify(body.tags) : body.tags
		});

		if (!updated) return json({ error: 'Update failed' }, { status: 500 });

		// Update schedule registration
		if (updated.enabled && updated.schedule) {
			await registerSchedule(updated.id, 'backup', updated.environmentId);
		} else {
			unregisterSchedule(updated.id, 'backup');
		}

		await auditBackup(event, 'update', updated.targetName, updated.environmentId, { configId: id });
		return json(updated);
	} catch (error: any) {
		return json({ error: error.message }, { status: 500 });
	}
};

/**
 * DELETE /api/backup/configs/{id} - Delete a backup configuration
 *
 * @openapi
 * summary: Delete a backup configuration and unregister its schedule
 * description: Permission ("backups:manage") and environment-access denials (403) and not-found (404) are produced by the shared route guards.
 * path: id:integer! Backup configuration id (from GET /api/backup/configs)
 * resp-200: Returns { success: true } once the configuration is deleted
 * resp-200-example: {"success":true}
 * resp-409: A backup is currently running for this config — stop it before deleting
 */
export const DELETE: RequestHandler = async (event) => {
	const { params, cookies } = event;
	const auth = await authorize(cookies);
	const denied = await requireBackups(auth, 'manage');
	if (denied) return denied;

	// Environment access check (enterprise RBAC). Config's env is fixed at creation.
	const gated = await loadConfigGateEnv(params.id, auth);
	if ('response' in gated) return gated.response;
	const existing = gated.config;
	const id = existing.id;

	// (audit #55) Don't delete a config out from under an in-flight backup — the
	// run's helper containers + lock reference it; deleting mid-run is messy.
	if (isBackupRunning(id)) {
		return json({ error: 'A backup is currently running for this config — stop it before deleting' }, { status: 409 });
	}

	// Unregister schedule before deleting
	unregisterSchedule(id, 'backup');

	await deleteBackupConfig(id);
	await auditBackup(event, 'delete', existing.targetName, existing.environmentId, { configId: id });
	return json({ success: true });
};
