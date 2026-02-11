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

export const POST: RequestHandler = async ({ params }) => {
	try {
		const { type, id } = params;
		const scheduleId = parseInt(id, 10);

		if (isNaN(scheduleId)) {
			return json({ error: 'Invalid schedule ID' }, { status: 400 });
		}

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
