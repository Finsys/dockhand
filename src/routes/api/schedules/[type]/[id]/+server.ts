/**
 * Delete schedule
 * DELETE /api/schedules/:type/:id
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getAutoUpdateSettingById,
	deleteAutoUpdateSchedule,
	getGitStack,
	updateGitStack,
	deleteEnvUpdateCheckSettings,
	deleteImagePruneSettings
} from '$lib/server/db';
import { unregisterSchedule } from '$lib/server/scheduler';
import { authorize } from '$lib/server/authorize';

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
			// Hard delete container schedule
			const schedule = await getAutoUpdateSettingById(scheduleId);
			if (schedule) {
				const envDenied = await auth.requireEnvAccess(schedule.environmentId);
				if (envDenied) return envDenied;
				await deleteAutoUpdateSchedule(schedule.containerName, schedule.environmentId ?? undefined);
				// Unregister from croner
				unregisterSchedule(scheduleId, 'container_update');
			}
			return json({ success: true });

		} else if (type === 'git_stack_sync') {
			const stack = await getGitStack(scheduleId);
			if (!stack) {
				return json({ error: 'Schedule not found' }, { status: 404 });
			}
			const envDenied = await auth.requireEnvAccess(stack.environmentId);
			if (envDenied) return envDenied;
			// Disable auto-update for git stack (don't delete the stack itself)
			await updateGitStack(scheduleId, {
				autoUpdate: false,
				autoUpdateSchedule: null,
				autoUpdateCron: null
			});
			// Unregister from croner
			unregisterSchedule(scheduleId, 'git_stack_sync');
			return json({ success: true });

		} else if (type === 'env_update_check') {
			// Delete env update check settings (scheduleId is environmentId)
			const envDenied = await auth.requireEnvAccess(scheduleId);
			if (envDenied) return envDenied;
			await deleteEnvUpdateCheckSettings(scheduleId);
			unregisterSchedule(scheduleId, 'env_update_check');
			return json({ success: true });

		} else if (type === 'image_prune') {
			// Delete image prune settings (scheduleId is environmentId)
			const envDenied = await auth.requireEnvAccess(scheduleId);
			if (envDenied) return envDenied;
			await deleteImagePruneSettings(scheduleId);
			unregisterSchedule(scheduleId, 'image_prune');
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
