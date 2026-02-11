/**
 * Toggle schedule enabled/disabled
 * POST /api/schedules/:type/:id/toggle
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAutoUpdateSettingById, updateAutoUpdateSettingById, getGitStack, updateGitStack, getEnvUpdateCheckSettings, setEnvUpdateCheckSettings, getImagePruneSettings, setImagePruneSettings } from '$lib/server/db';
import { registerSchedule, unregisterSchedule } from '$lib/server/scheduler';

export const POST: RequestHandler = async ({ params }) => {
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
