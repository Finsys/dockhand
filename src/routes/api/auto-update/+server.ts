import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAutoUpdateSettings } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';

/**
 * Batch endpoint to get all auto-update settings for an environment.
 * Returns a map of containerName -> settings for efficient lookup.
 *
 * @openapi
 * summary: Get all enabled auto-update settings for an environment, keyed by container name
 * query: env:integer Environment ID to read settings for (from GET /api/environments)
 * resp-200: {}
 * resp-200-example: {"web-1":{"enabled":true,"scheduleType":"daily","cronExpression":"0 3 * * *","vulnerabilityCriteria":"never"}}
 * resp-403: Permission denied (needs schedules:view, and access to the environment)
 * resp-500: Failed to get auto-update settings
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	// The same answer as the per-container route, for every container at once, so it
	// carries the same gate: these are the cron schedules on which each container is
	// recreated, and whether a vulnerability finding would stop that.
	const auth = await authorize(cookies);

	const permDenied = await auth.requirePermission('schedules', 'view');
	if (permDenied) return permDenied;

	try {
		const envIdParam = url.searchParams.get('env');
		const envId = envIdParam ? parseInt(envIdParam) : undefined;

		const envDenied = await auth.requireEnvAccess(envId);
		if (envDenied) return envDenied;

		const settings = await getAutoUpdateSettings(envId);

		// Without ?env= the query spans every environment, and the check above only
		// answers for a named one, so the answer is narrowed to what this caller may
		// actually see. Null means no restriction (admin, free edition, auth off).
		const accessible = envId === undefined ? await auth.getAccessibleEnvironmentIds() : null;
		const visible =
			accessible === null
				? settings
				: settings.filter(
						(s) => s.environmentId === null || accessible.includes(s.environmentId)
					);

		// Convert to a map keyed by container name for efficient frontend lookup
		const settingsMap: Record<string, {
			enabled: boolean;
			scheduleType: string;
			cronExpression: string | null;
			vulnerabilityCriteria: string;
		}> = {};

		for (const setting of visible) {
			if (setting.enabled) {
				settingsMap[setting.containerName] = {
					enabled: setting.enabled,
					scheduleType: setting.scheduleType,
					cronExpression: setting.cronExpression,
					vulnerabilityCriteria: setting.vulnerabilityCriteria || 'never'
				};
			}
		}

		return json(settingsMap);
	} catch (error) {
		console.error('Failed to get auto-update settings:', error);
		return json({ error: 'Failed to get auto-update settings' }, { status: 500 });
	}
};
