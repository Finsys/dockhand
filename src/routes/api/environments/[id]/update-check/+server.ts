import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import {
	getEnvUpdateCheckSettings,
	setEnvUpdateCheckSettings,
	getEnvironment
} from '$lib/server/db';
import { registerSchedule, unregisterSchedule } from '$lib/server/scheduler';

/**
 * Get update check settings for an environment.
 *
 * @openapi
 * summary: Get the automatic container-image update-check schedule for an environment
 * path: id:integer! Environment id (from GET /api/environments)
 * resp-200: {settings:{enabled:boolean!, cron:string!, autoUpdate:boolean!, vulnerabilityCriteria:string!}!}
 * resp-200-example: {"settings":{"enabled":false,"cron":"0 4 * * *","autoUpdate":false,"vulnerabilityCriteria":"never"}}
 * resp-403: Permission denied (RBAC 'environments:view' missing)
 * resp-404: Environment not found
 * resp-500: Unexpected error while loading the settings
 */
export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('environments', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);

		// Verify environment exists
		const env = await getEnvironment(id);
		if (!env) {
			return json({ error: 'Environment not found' }, { status: 404 });
		}

		const settings = await getEnvUpdateCheckSettings(id);

		return json({
			settings: settings || {
				enabled: false,
				cron: '0 4 * * *',
				autoUpdate: false,
				vulnerabilityCriteria: 'never'
			}
		});
	} catch (error) {
		console.error('Failed to get update check settings:', error);
		return json({ error: 'Failed to get update check settings' }, { status: 500 });
	}
};

/**
 * Save update check settings for an environment.
 *
 * @openapi
 * summary: Save the automatic image update-check schedule for an environment (registers/unregisters the croner job)
 * path: id:integer! Environment id (from GET /api/environments)
 * body: {enabled:boolean, cron:string, autoUpdate:boolean, vulnerabilityCriteria:string}
 * body-example: {"enabled":true,"cron":"0 4 * * *","autoUpdate":false,"vulnerabilityCriteria":"never"}
 * resp-200: {success:boolean!, settings:{enabled:boolean!, cron:string!, autoUpdate:boolean!, vulnerabilityCriteria:string!}!}
 * resp-403: Permission denied (RBAC 'environments:edit' missing)
 * resp-404: Environment not found
 * resp-500: Unexpected error while saving the settings
 */
export const POST: RequestHandler = async ({ params, request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('environments', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);

		// Verify environment exists
		const env = await getEnvironment(id);
		if (!env) {
			return json({ error: 'Environment not found' }, { status: 404 });
		}

		const data = await request.json();

		const settings = {
			enabled: data.enabled ?? false,
			cron: data.cron || '0 4 * * *',
			autoUpdate: data.autoUpdate ?? false,
			vulnerabilityCriteria: data.vulnerabilityCriteria || 'never'
		};

		// Save settings to database
		await setEnvUpdateCheckSettings(id, settings);

		// Register or unregister schedule based on enabled state
		if (settings.enabled) {
			await registerSchedule(id, 'env_update_check', id);
		} else {
			unregisterSchedule(id, 'env_update_check');
		}

		return json({ success: true, settings });
	} catch (error) {
		console.error('Failed to save update check settings:', error);
		return json({ error: 'Failed to save update check settings' }, { status: 500 });
	}
};
