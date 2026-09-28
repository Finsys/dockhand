import { json, type RequestHandler } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import { getMinimumReleaseAgeConfig, setMinimumReleaseAgeHours } from '$lib/server/minimum-release-age';
import { parseMinimumReleaseAgeHours } from '$lib/server/minimum-release-age-core';

/**
 * @openapi
 * summary: Get the minimum image age in hours (creation time, with first-observed fallback)
 * resp-200: {hours:number!, overridden:boolean!, inherited:boolean!}
 */
export const GET: RequestHandler = async ({ cookies }) => {
	await authorize(cookies);
	return json(await getMinimumReleaseAgeConfig());
};

/**
 * @openapi
 * summary: Set the minimum image age in hours (creation time, with first-observed fallback)
 * body: {hours:number!}
 * resp-200: {hours:number!, overridden:boolean!}
 * resp-400: Hours must be a whole number from 0 to 720
 * resp-403: Permission denied (needs settings:edit)
 * resp-409: MINIMUM_RELEASE_AGE_HOURS overrides this setting
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('settings', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	const { hours: raw } = await request.json().catch(() => ({}));
	const hours = parseMinimumReleaseAgeHours(raw);
	if (hours === null) return json({ error: 'Hours must be a whole number from 0 to 720' }, { status: 400 });
	const config = await getMinimumReleaseAgeConfig();
	if (config.overridden) return json({ error: 'MINIMUM_RELEASE_AGE_HOURS overrides this setting' }, { status: 409 });
	await setMinimumReleaseAgeHours(hours);
	return json({ hours, overridden: false });
};
