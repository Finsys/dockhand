/**
 * Delete schedule
 * DELETE /api/schedules/:type/:id
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getAutoUpdateSettingById,
	deleteAutoUpdateSchedule,
	updateGitRepository,
	updateGitStack,
	deleteEnvUpdateCheckSettings,
	deleteImagePruneSettings,
	deleteBackupConfig,
	getBackupConfig,
	getBackupDestination,
	updateBackupDestination
} from '$lib/server/db';
import { unregisterSchedule } from '$lib/server/scheduler';
import { resolveGitScheduleTarget, isGitScheduleType } from '$lib/server/git-schedule-target';
import { authorize } from '$lib/server/authorize';

/**
 * @openapi
 * summary: Delete (or disable, for policy-driven types) a schedule by type and id
 * path: type:string! Schedule type (container_update, git_stack_sync, env_update_check, image_prune, backup, repo_prune, repo_check, repo_verify, system_cleanup)
 * path: id:integer! Schedule id (semantics depend on type — container/git-stack/backup-config id, environment id, or a synthetic repo-policy id) (from GET /api/schedules)
 * resp-200: {success:boolean!}
 * resp-400: Invalid schedule id, invalid/unsupported type, or system_cleanup (cannot be removed)
 * resp-404: Schedule (or backup destination, for repo_* types) not found
 * resp-500: Unexpected error while deleting the schedule
 */
export const DELETE: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);

	const permDenied = await auth.requirePermission('schedules', 'edit');
	if (permDenied) return permDenied;

	try {
		const { type, id } = params;
		const scheduleId = parseInt(id, 10);

		if (isNaN(scheduleId)) {
			return json({ error: 'Invalid schedule ID' }, { status: 400 });
		}

		if (type === 'container_update') {
			const schedule = await getAutoUpdateSettingById(scheduleId);
			if (schedule) {
				const envDenied = await auth.requireEnvAccess(schedule.environmentId);
				if (envDenied) return envDenied;
				await deleteAutoUpdateSchedule(schedule.containerName, schedule.environmentId ?? undefined);
				unregisterSchedule(scheduleId, 'container_update');
			}
			return json({ success: true });

		} else if (isGitScheduleType(type)) {
			// Git schedules resolve through the per-model target resolver (F12).
			const target = await resolveGitScheduleTarget(type, scheduleId);
			if (!target) {
				return json({ error: 'Schedule not found' }, { status: 404 });
			}

			if (target.kind === 'stack') {
				const envDenied = await auth.requireEnvAccess(target.entity.environmentId);
				if (envDenied) return envDenied;
				await updateGitStack(target.id, {
					autoUpdate: false,
					autoUpdateSchedule: null,
					autoUpdateCron: null
				});
				unregisterSchedule(target.id, 'git_stack_sync');
				return json({ success: true });
			}

			await updateGitRepository(target.id, {
				autoUpdate: false,
				autoUpdateSchedule: null,
				autoUpdateCron: null
			});
			unregisterSchedule(target.id, 'git_repository_sync');

			return json({
				success: true,
				...(type === 'git_stack_sync' ? { deprecated: true, repositoryId: target.id } : {})
			});
		} else if (type === 'env_update_check') {
			const envDenied = await auth.requireEnvAccess(scheduleId);
			if (envDenied) return envDenied;
			await deleteEnvUpdateCheckSettings(scheduleId);
			unregisterSchedule(scheduleId, 'env_update_check');
			return json({ success: true });

		} else if (type === 'image_prune') {
			const envDenied = await auth.requireEnvAccess(scheduleId);
			if (envDenied) return envDenied;
			await deleteImagePruneSettings(scheduleId);
			unregisterSchedule(scheduleId, 'image_prune');
			return json({ success: true });

		} else if (type === 'backup') {
			const cfg = await getBackupConfig(scheduleId);
			if (!cfg) {
				return json({ error: 'Schedule not found' }, { status: 404 });
			}
			const envDenied = await auth.requireEnvAccess(cfg.environmentId);
			if (envDenied) return envDenied;
			await deleteBackupConfig(scheduleId);
			unregisterSchedule(scheduleId, 'backup');
			return json({ success: true });

		} else if (type === 'repo_prune' || type === 'repo_check' || type === 'repo_verify') {
			// Repo maintenance schedules are policy-driven; there is no standalone
			// row to delete. "Delete" here means disable the policy (audit #18).
			// The schedule id is synthetic — decode to the real destination id.
			const REPO_ID_OFFSET: Record<string, number> = {
				repo_prune: 100000, repo_check: 200000, repo_verify: 300000
			};
			const destId = scheduleId - REPO_ID_OFFSET[type];
			const dest = await getBackupDestination(destId);
			if (!dest) {
				return json({ error: 'Destination not found' }, { status: 404 });
			}
			const policies = dest.policies
				? (() => { try { return JSON.parse(dest.policies); } catch { return {}; } })()
				: {};
			const enabledKey = type === 'repo_prune' ? 'pruneEnabled'
				: type === 'repo_check' ? 'checkEnabled' : 'verifyEnabled';
			policies[enabledKey] = false;
			await updateBackupDestination(destId, { policies: JSON.stringify(policies) });
			unregisterSchedule(destId, type);
			return json({ success: true });

		} else if (type === 'system_cleanup') {
			return json({ error: 'System schedules cannot be removed' }, { status: 400 });

		} else {
			return json({ error: 'Invalid schedule type' }, { status: 400 });
		}
	} catch (error) {
		console.error('Failed to delete schedule:', error);
		return json({ error: 'Failed to delete schedule' }, { status: 500 });
	}
};
