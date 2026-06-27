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
import { authorize } from '$lib/server/authorize';
import { getAutoUpdateSettingById, getGitStack } from '$lib/server/db';

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
