import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getContainerStartSchedules } from '$lib/server/db';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const envIdParam = url.searchParams.get('env');
		const envId = envIdParam ? parseInt(envIdParam) : undefined;

		const settings = await getContainerStartSchedules(envId);
		const settingsMap: Record<string, {
			enabled: boolean;
			scheduleType: string;
			cronExpression: string | null;
		}> = {};

		for (const setting of settings) {
			if (setting.enabled) {
				settingsMap[setting.containerName] = {
					enabled: setting.enabled,
					scheduleType: setting.scheduleType,
					cronExpression: setting.cronExpression
				};
			}
		}

		return json(settingsMap);
	} catch (error) {
		console.error('Failed to get container start schedules:', error);
		return json({ error: 'Failed to get container start schedules' }, { status: 500 });
	}
};
