import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { getEnvironment, getEnvSetting, setEnvSetting } from '$lib/server/db';

/**
 * @openapi
 * summary: Get the disk-space warning thresholds for an environment
 * path: id:integer! Environment id (from GET /api/environments)
 * resp-200: {enabled:boolean!, mode:string!, threshold:integer!, thresholdGb:integer!}
 * resp-200-example: {"enabled":true,"mode":"percentage","threshold":80,"thresholdGb":50}
 * resp-403: Permission denied (RBAC 'environments:view' missing)
 * resp-404: Environment not found
 * resp-500: Unexpected error while loading the settings
 */
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

/**
 * @openapi
 * summary: Save the disk-space warning thresholds for an environment (each field optional/independent)
 * path: id:integer! Environment id (from GET /api/environments)
 * body: {enabled:boolean, mode:string, threshold:integer, thresholdGb:integer}
 * body-example: {"enabled":true,"mode":"percentage","threshold":85}
 * resp-200: {success:boolean!}
 * resp-403: Permission denied (RBAC 'environments:edit' missing)
 * resp-404: Environment not found
 * resp-500: Unexpected error while saving the settings
 */
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
