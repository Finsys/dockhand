/**
 * Toggle schedule enabled/disabled
 * POST /api/schedules/:type/:id/toggle
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAutoUpdateSettingById, updateAutoUpdateSettingById, getGitStack, updateGitStack, getEnvUpdateCheckSettings, setEnvUpdateCheckSettings, getImagePruneSettings, setImagePruneSettings, getBackupConfig, updateBackupConfig, getBackupDestination, updateBackupDestination } from '$lib/server/db';
import { registerSchedule, unregisterSchedule } from '$lib/server/scheduler';
import { authorize } from '$lib/server/authorize';
import { auditBackup, auditBackupDestination } from '$lib/server/audit';

/**
 * @openapi
 * summary: Toggle a schedule's enabled/disabled state (registers/unregisters the croner job accordingly)
 * path: type:string! Schedule type (container_update, git_stack_sync, env_update_check, image_prune, backup, repo_prune, repo_check, repo_verify, system_cleanup)
 * path: id:integer! Schedule id (semantics depend on type) (from GET /api/schedules)
 * resp-200: {success:boolean!, enabled:boolean!}
 * resp-400: Invalid schedule id, unsupported type, or system_cleanup (cannot be paused)
 * resp-404: Schedule, backup config, or backup destination not found
 * resp-500: Unexpected error while toggling the schedule
 */
export const POST: RequestHandler = async (event) => {
	const { params, cookies } = event;
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
			const setting = await getAutoUpdateSettingById(scheduleId);
			if (!setting) {
				return json({ error: 'Schedule not found' }, { status: 404 });
			}
			const envDenied = await auth.requireEnvAccess(setting.environmentId);
			if (envDenied) return envDenied;

			const newEnabled = !setting.enabled;
			await updateAutoUpdateSettingById(scheduleId, {
				enabled: newEnabled
			});

			// Register or unregister schedule with croner
			if (newEnabled && setting.cronExpression) {
				await registerSchedule(scheduleId, 'container_update', setting.environmentId);
			} else {
				unregisterSchedule(scheduleId, 'container_update');
			}

			return json({ success: true, enabled: newEnabled });
		} else if (type === 'git_stack_sync') {
			const stack = await getGitStack(scheduleId);
			if (!stack) {
				return json({ error: 'Schedule not found' }, { status: 404 });
			}
			const envDenied = await auth.requireEnvAccess(stack.environmentId);
			if (envDenied) return envDenied;

			const newEnabled = !stack.autoUpdate;
			await updateGitStack(scheduleId, {
				autoUpdate: newEnabled
			});

			// Register or unregister schedule with croner
			if (newEnabled && stack.autoUpdateCron) {
				await registerSchedule(scheduleId, 'git_stack_sync', stack.environmentId);
			} else {
				unregisterSchedule(scheduleId, 'git_stack_sync');
			}

			return json({ success: true, enabled: newEnabled });
		} else if (type === 'env_update_check') {
			// scheduleId is environmentId for env update check
			const envDenied = await auth.requireEnvAccess(scheduleId);
			if (envDenied) return envDenied;
			const config = await getEnvUpdateCheckSettings(scheduleId);
			if (!config) {
				return json({ error: 'Schedule not found' }, { status: 404 });
			}

			const newEnabled = !config.enabled;
			await setEnvUpdateCheckSettings(scheduleId, {
				...config,
				enabled: newEnabled
			});

			// Register or unregister schedule with croner
			if (newEnabled && config.cron) {
				await registerSchedule(scheduleId, 'env_update_check', scheduleId);
			} else {
				unregisterSchedule(scheduleId, 'env_update_check');
			}

			return json({ success: true, enabled: newEnabled });
		} else if (type === 'image_prune') {
			// scheduleId is environmentId for image prune
			const envDenied = await auth.requireEnvAccess(scheduleId);
			if (envDenied) return envDenied;
			const config = await getImagePruneSettings(scheduleId);
			if (!config) {
				return json({ error: 'Schedule not found' }, { status: 404 });
			}

			const newEnabled = !config.enabled;
			await setImagePruneSettings(scheduleId, {
				...config,
				enabled: newEnabled
			});

			// Register or unregister schedule with croner
			if (newEnabled && config.cronExpression) {
				await registerSchedule(scheduleId, 'image_prune', scheduleId);
			} else {
				unregisterSchedule(scheduleId, 'image_prune');
			}

			return json({ success: true, enabled: newEnabled });
		} else if (type === 'backup') {
			const config = await getBackupConfig(scheduleId);
			if (!config) {
				return json({ error: 'Backup config not found' }, { status: 404 });
			}
			const envDenied = await auth.requireEnvAccess(config.environmentId);
			if (envDenied) return envDenied;

			const newEnabled = !config.enabled;
			await updateBackupConfig(scheduleId, { enabled: newEnabled });

			if (newEnabled && config.schedule) {
				await registerSchedule(scheduleId, 'backup', config.environmentId);
			} else {
				unregisterSchedule(scheduleId, 'backup');
			}

			await auditBackup(event, 'update', config.targetName, config.environmentId, { configId: scheduleId, enabled: newEnabled });

			return json({ success: true, enabled: newEnabled });
		} else if (type === 'repo_prune' || type === 'repo_check' || type === 'repo_verify') {
			// Repo maintenance schedules are policy-driven on the destination.
			// Toggling flips the corresponding *Enabled flag in the destination's
			// policies JSON (audit #18). The schedule id is synthetic — decode it
			// back to the real destination id (same offsets as the run endpoint).
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
			const newEnabled = !policies[enabledKey];
			policies[enabledKey] = newEnabled;

			await updateBackupDestination(destId, { policies: JSON.stringify(policies) });

			// Re-register (or unregister) the repo maintenance job (env-less).
			await registerSchedule(destId, type, null);

			await auditBackupDestination(event, 'update', destId, dest.name, { policy: enabledKey, enabled: newEnabled });

			return json({ success: true, enabled: newEnabled });
		} else if (type === 'system_cleanup') {
			return json({ error: 'System schedules cannot be paused' }, { status: 400 });
		} else {
			return json({ error: 'Invalid schedule type' }, { status: 400 });
		}
	} catch (error) {
		console.error('Failed to toggle schedule:', error);
		return json({ error: 'Failed to toggle schedule' }, { status: 500 });
	}
};
