/**
 * Manual Schedule Trigger API - Manually run a schedule
 *
 * POST /api/schedules/[type]/[id]/run - Trigger a manual execution
 *
 * Path params:
 *   - type: 'container_update' | 'git_stack_sync' | 'system_cleanup' | 'env_update_check' | 'image_prune'
 *   - id: schedule ID
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { triggerContainerUpdate, triggerGitStackSync, triggerSystemJob, triggerEnvUpdateCheck, triggerImagePrune } from '$lib/server/scheduler';
import { getBackupConfig, getBackupDestination } from '$lib/server/db';
import { runScheduledBackup } from '$lib/server/scheduler/tasks/backup';
import { runRepoPrune, runRepoCheck, runRepoVerify } from '$lib/server/scheduler/tasks/repo-maintenance';
import { authorize } from '$lib/server/authorize';
import { getAutoUpdateSettingById, getGitStack } from '$lib/server/db';
import { BACKUPS_ENABLED } from '$lib/server/features';

/**
 * @openapi
 * summary: Manually trigger a single run of a schedule (outside its cron), by type and id
 * path: type:string! Schedule type (container_update, git_stack_sync, system_cleanup, env_update_check, image_prune, backup, repo_prune, repo_check, repo_verify)
 * path: id:integer! Schedule id (semantics depend on type) (from GET /api/schedules)
 * resp-200: {success:boolean!, message:string!}
 * resp-400: Invalid schedule id/type, or the triggered task itself reported failure
 * resp-404: Schedule, backup config, or backup destination not found (or backup feature disabled)
 * resp-500: Unexpected error while triggering the schedule
 */
export const POST: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);

	const permDenied = await auth.requirePermission('schedules', 'run');
	if (permDenied) return permDenied;

	try {
		const { type, id } = params;
		const scheduleId = parseInt(id, 10);

		if (isNaN(scheduleId)) {
			return json({ error: 'Invalid schedule ID' }, { status: 400 });
		}

		// BETA GATE: backup-type schedules are unreachable unless FEAT_BACKUPS_ENABLED (see features.ts).
		if (!BACKUPS_ENABLED && (type === 'backup' || type === 'repo_prune' || type === 'repo_check' || type === 'repo_verify')) {
			return new Response('Not found', { status: 404 });
		}

		// The schedules stream emits synthetic IDs for the three repo-maintenance
		// rows per destination (dest.id + 100000/200000/300000) to keep them unique
		// in the UI list. Decode back to the real destination id here (audit #7)
		// so getBackupDestination() actually matches. Backup/other types pass through.
		const REPO_ID_OFFSET: Record<string, number> = {
			repo_prune: 100000, repo_check: 200000, repo_verify: 300000
		};
		const destId = REPO_ID_OFFSET[type] ? scheduleId - REPO_ID_OFFSET[type] : scheduleId;

		// Resolve schedule → environmentId so we can enforce per-env access
		// before triggering. System schedules (env null) are gated only by
		// the global schedules:run check above.
		let scheduleEnvId: number | null = null;
		switch (type) {
			case 'container_update': {
				const setting = await getAutoUpdateSettingById(scheduleId);
				if (!setting) return json({ error: 'Schedule not found' }, { status: 404 });
				scheduleEnvId = setting.environmentId;
				break;
			}
			case 'git_stack_sync': {
				const stack = await getGitStack(scheduleId);
				if (!stack) return json({ error: 'Schedule not found' }, { status: 404 });
				scheduleEnvId = stack.environmentId;
				break;
			}
			case 'env_update_check':
			case 'image_prune':
				scheduleEnvId = scheduleId;
				break;
			case 'system_cleanup':
				scheduleEnvId = null;
				break;
			case 'backup': {
				// Backup schedules ARE env-scoped (audit #6: these were missing here
				// and 400'd before ever reaching the dispatch switch below).
				const config = await getBackupConfig(scheduleId);
				if (!config) return json({ error: 'Backup config not found' }, { status: 404 });
				scheduleEnvId = config.environmentId;
				break;
			}
			case 'repo_prune':
			case 'repo_check':
			case 'repo_verify': {
				// Repo maintenance is destination-scoped, not env-scoped. Validate the
				// (decoded) destination exists; access is gated by schedules:run only.
				const dest = await getBackupDestination(destId);
				if (!dest) return json({ error: 'Destination not found' }, { status: 404 });
				scheduleEnvId = null;
				break;
			}
			default:
				return json({ error: 'Invalid schedule type' }, { status: 400 });
		}

		const envDenied = await auth.requireEnvAccess(scheduleEnvId);
		if (envDenied) return envDenied;

		let result: { success: boolean; executionId?: number; error?: string };

		switch (type) {
			case 'container_update':
				result = await triggerContainerUpdate(scheduleId);
				break;
			case 'git_stack_sync':
				result = await triggerGitStackSync(scheduleId);
				break;
			case 'system_cleanup':
				result = await triggerSystemJob(id);
				break;
			case 'env_update_check':
				result = await triggerEnvUpdateCheck(scheduleId);
				break;
			case 'image_prune':
				result = await triggerImagePrune(scheduleId);
				break;
			case 'backup': {
				const config = await getBackupConfig(scheduleId);
				if (!config) {
					return json({ error: 'Backup config not found' }, { status: 404 });
				}
				await runScheduledBackup(scheduleId, config.targetName, config.environmentId, 'manual');
				result = { success: true };
				break;
			}
			case 'repo_prune': {
				const dest = await getBackupDestination(destId);
				if (!dest) return json({ error: 'Destination not found' }, { status: 404 });
				await runRepoPrune(destId, dest.name, 'manual');
				result = { success: true };
				break;
			}
			case 'repo_check': {
				const dest = await getBackupDestination(destId);
				if (!dest) return json({ error: 'Destination not found' }, { status: 404 });
				await runRepoCheck(destId, dest.name, 'manual');
				result = { success: true };
				break;
			}
			case 'repo_verify': {
				const dest = await getBackupDestination(destId);
				if (!dest) return json({ error: 'Destination not found' }, { status: 404 });
				const pol = dest.policies ? (() => { try { return JSON.parse(dest.policies); } catch { return {}; } })() : {};
				await runRepoVerify(destId, dest.name, pol.verifyDataSubset || '5%', 'manual');
				result = { success: true };
				break;
			}
			default:
				// Unreachable — validated in the resolution switch above.
				return json({ error: 'Invalid schedule type' }, { status: 400 });
		}

		if (!result.success) {
			return json({ error: result.error }, { status: 400 });
		}

		return json({ success: true, message: 'Schedule triggered successfully' });
	} catch (error: any) {
		console.error('Failed to trigger schedule:', error);
		return json({ error: error.message }, { status: 500 });
	}
};
