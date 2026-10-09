import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import {
	getEnvReportSettings,
	setEnvReportSettings,
	getEnvironment,
	getNotificationSettings,
	type EnvReportSettings
} from '$lib/server/db';
import { registerSchedule, unregisterSchedule } from '$lib/server/scheduler';

const DEFAULTS: EnvReportSettings = {
	enabled: false,
	cron: '0 6 1 * *',
	format: 'pdf',
	notificationId: null
};

/**
 * Get the scheduled state report settings for an environment.
 *
 * @openapi
 * summary: Get the scheduled state report configuration for an environment
 * description: Administrator only. The report lists everything running and every vulnerability known about it, and the schedule mails it out of the installation unattended, so configuring it is not delegated by a role.
 * path: id:integer! Environment id (from GET /api/environments)
 * resp-200: {settings:{enabled:boolean!, cron:string!, format:string!, notificationId:integer}!}
 * resp-200-example: {"settings":{"enabled":false,"cron":"0 6 1 * *","format":"pdf","notificationId":null}}
 * resp-403: Only an administrator can read the report schedule
 * resp-404: Environment not found
 * resp-500: Unexpected error while loading the settings
 */
export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !auth.isAdmin) {
		return json({ error: 'Only an administrator can configure scheduled reports' }, { status: 403 });
	}
	const id = parseInt(params.id);
	const envAccessDenied = await auth.requireEnvAccess(id);
	if (envAccessDenied) return envAccessDenied;

	try {
		const env = await getEnvironment(id);
		if (!env) return json({ error: 'Environment not found' }, { status: 404 });

		return json({ settings: (await getEnvReportSettings(id)) ?? DEFAULTS });
	} catch (error) {
		console.error('Failed to get report settings:', error);
		return json({ error: 'Failed to get report settings' }, { status: 500 });
	}
};

/**
 * Save the scheduled state report settings for an environment.
 *
 * @openapi
 * summary: Save the scheduled state report configuration for an environment (registers/unregisters the croner job)
 * description: Administrator only. The channel must be an SMTP one - no other channel type can carry the report as an attachment.
 * path: id:integer! Environment id (from GET /api/environments)
 * body: {enabled:boolean, cron:string, format:string, notificationId:integer}
 * body-example: {"enabled":true,"cron":"0 6 1 * *","format":"pdf","notificationId":3}
 * resp-200: {success:boolean!, settings:{enabled:boolean!, cron:string!, format:string!, notificationId:integer}!}
 * resp-400: The format must be pdf or csv, or the channel is missing, unknown, disabled or not an SMTP channel
 * resp-403: Only an administrator can configure scheduled reports, or no commercial license is active
 * resp-404: Environment not found
 * resp-500: Unexpected error while saving the settings
 */
export const POST: RequestHandler = async ({ params, request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !auth.isAdmin) {
		return json({ error: 'Only an administrator can configure scheduled reports' }, { status: 403 });
	}
	const id = parseInt(params.id);
	const envAccessDenied = await auth.requireEnvAccess(id);
	if (envAccessDenied) return envAccessDenied;

	try {
		const env = await getEnvironment(id);
		if (!env) return json({ error: 'Environment not found' }, { status: 404 });

		const data = await request.json().catch(() => ({}));
		const format = data.format === 'csv' ? 'csv' : data.format === 'pdf' ? 'pdf' : null;
		if (data.format !== undefined && format === null) {
			return json({ error: 'Format must be pdf or csv' }, { status: 400 });
		}

		const notificationId = typeof data.notificationId === 'number' ? data.notificationId : null;
		const settings: EnvReportSettings = {
			enabled: data.enabled ?? false,
			cron: data.cron || DEFAULTS.cron,
			format: format ?? DEFAULTS.format,
			notificationId
		};

		// A schedule that cannot deliver is worse than no schedule: it fails silently every
		// month until somebody notices the report never arrived. Refuse it at the point the
		// administrator can still fix it.
		if (settings.enabled) {
			// A schedule the licence cannot run is not a schedule, it is a monthly failure.
			if (auth.licenseTier !== 'enterprise' && auth.licenseTier !== 'smb') {
				return json(
					{ error: 'A commercial license is required to send a state report' },
					{ status: 403 }
				);
			}
			if (notificationId === null) {
				return json({ error: 'Choose an SMTP channel to send the report to' }, { status: 400 });
			}
			const channel = (await getNotificationSettings()).find((c) => c.id === notificationId);
			if (!channel) {
				return json({ error: 'The selected notification channel no longer exists' }, { status: 400 });
			}
			if (channel.type !== 'smtp') {
				return json({ error: 'Only an SMTP channel can carry the report as an attachment' }, { status: 400 });
			}
			if (channel.enabled === false) {
				return json({ error: 'The selected notification channel is disabled' }, { status: 400 });
			}
		}

		await setEnvReportSettings(id, settings);

		if (settings.enabled) {
			await registerSchedule(id, 'env_report', id);
		} else {
			unregisterSchedule(id, 'env_report');
		}

		return json({ success: true, settings });
	} catch (error) {
		console.error('Failed to save report settings:', error);
		return json({ error: 'Failed to save report settings' }, { status: 500 });
	}
};
