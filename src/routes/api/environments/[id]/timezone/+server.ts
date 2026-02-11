import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import {
	getEnvironmentTimezone,
	setEnvironmentTimezone,
	getEnvironment
} from '$lib/server/db';
import { refreshSchedulesForEnvironment } from '$lib/server/scheduler';

/** Map of modern IANA timezone names to their canonical equivalents recognized by Bun/ICU */
const TIMEZONE_ALIASES: Record<string, string> = {
	'Europe/Kyiv': 'Europe/Kiev',
	'Asia/Ho_Chi_Minh': 'Asia/Saigon',
	'America/Nuuk': 'America/Godthab',
	'Pacific/Kanton': 'Pacific/Enderbury'
};

function normalizeTimezone(tz: string): string {
	return TIMEZONE_ALIASES[tz] || tz;
}

/**
 * Get timezone for an environment.
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

		const rawTimezone = await getEnvironmentTimezone(id);
		const timezone = normalizeTimezone(rawTimezone);

		return json({ timezone });
	} catch (error) {
		console.error('Failed to get environment timezone:', error);
		return json({ error: 'Failed to get environment timezone' }, { status: 500 });
	}
};

/**
 * Set timezone for an environment.
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
		const timezone = normalizeTimezone(data.timezone || 'UTC');

		// Validate timezone
		const validTimezones = Intl.supportedValuesOf('timeZone');
		if (!validTimezones.includes(timezone) && timezone !== 'UTC') {
			return json({ error: 'Invalid timezone' }, { status: 400 });
		}

		await setEnvironmentTimezone(id, timezone);

		// Refresh all schedules for this environment to use the new timezone
		await refreshSchedulesForEnvironment(id);

		return json({ success: true, timezone });
	} catch (error) {
		console.error('Failed to set environment timezone:', error);
		return json({ error: 'Failed to set environment timezone' }, { status: 500 });
	}
};
