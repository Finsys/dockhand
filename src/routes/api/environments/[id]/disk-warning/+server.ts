import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { getEnvironment, getEnvSetting, setEnvSetting } from '$lib/server/db';

export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('environments', 'view'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);
		const env = await getEnvironment(id);
		if (!env) {
			return json({ error: 'Environment not found' }, { status: 404 });
		}

		const enabled = (await getEnvSetting('disk_warning_enabled', id)) ?? true;
		const mode = (await getEnvSetting('disk_warning_mode', id)) ?? 'percentage';
		const threshold = (await getEnvSetting('disk_warning_threshold', id)) ?? 80;
		const thresholdGb = (await getEnvSetting('disk_warning_threshold_gb', id)) ?? 50;

		return json({ enabled, mode, threshold, thresholdGb });
	} catch (error) {
		console.error('Failed to get disk warning settings:', error);
		return json({ error: 'Failed to get disk warning settings' }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ params, request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('environments', 'edit'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);
		const env = await getEnvironment(id);
		if (!env) {
			return json({ error: 'Environment not found' }, { status: 404 });
		}

		const data = await request.json();

		if (typeof data.enabled === 'boolean') {
			await setEnvSetting('disk_warning_enabled', data.enabled, id);
		}
		if (data.mode === 'percentage' || data.mode === 'absolute') {
			await setEnvSetting('disk_warning_mode', data.mode, id);
		}
		if (typeof data.threshold === 'number' && data.threshold >= 1 && data.threshold <= 100) {
			await setEnvSetting('disk_warning_threshold', data.threshold, id);
		}
		if (typeof data.thresholdGb === 'number' && data.thresholdGb >= 1) {
			await setEnvSetting('disk_warning_threshold_gb', data.thresholdGb, id);
		}

		return json({ success: true });
	} catch (error) {
		console.error('Failed to save disk warning settings:', error);
		return json({ error: 'Failed to save disk warning settings' }, { status: 500 });
	}
};
