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
				vulnerabilityCriteria: 'never',
				minimumImageAgeDays: 0,
				bypassAgeForSecurityFixes: false
			}
		});
	} catch (error) {
		console.error('Failed to get update check settings:', error);
		return json({ error: 'Failed to get update check settings' }, { status: 500 });
	}
};

/**
 * Save update check settings for an environment.
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

		const rawAge = Number(data.minimumImageAgeDays ?? 0);
		if (!Number.isFinite(rawAge) || rawAge < 0) {
			return json({ error: 'minimumImageAgeDays must be a non-negative number' }, { status: 400 });
		}

		const settings = {
			enabled: data.enabled ?? false,
			cron: data.cron || '0 4 * * *',
			autoUpdate: data.autoUpdate ?? false,
			vulnerabilityCriteria: data.vulnerabilityCriteria || 'never',
			minimumImageAgeDays: Math.min(365, Math.floor(rawAge)),
			bypassAgeForSecurityFixes: Boolean(data.bypassAgeForSecurityFixes ?? false)
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
