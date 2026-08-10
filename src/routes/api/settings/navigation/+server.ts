import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import {
	getGlobalNavPreferences, setGlobalNavPreferences,
	getUserNavPreferences, setUserNavPreferences,
	getEffectiveNavPreferences,
	parseNavPatch,
	type NavPreferences
} from '$lib/server/nav-preferences';
import { validateSession, isAuthEnabled } from '$lib/server/auth';
import { authorize } from '$lib/server/authorize';

// GET /api/settings/navigation — returns effective prefs (for redirect/env-click), plus the raw
// global + per-user values so the UI can show what's inherited. Auth off => global only.
/**
 * @openapi
 * summary: Get the effective navigation preferences (landing page, env-click target) plus the raw global and per-user values
 * resp-200: {effective:{landingPage:string!, envClickPage:string!}, global:{landingPage:string, envClickPage:string}, user:{landingPage:string, envClickPage:string}}
 * resp-200-example: {"effective":{"landingPage":"dashboard","envClickPage":"containers"},"global":{"landingPage":null,"envClickPage":null},"user":null}
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const authEnabled = await isAuthEnabled();
	const user = authEnabled ? await validateSession(cookies) : null;
	const global = await getGlobalNavPreferences();
	const userPrefs = user ? await getUserNavPreferences(user.id) : null;
	const effective = await getEffectiveNavPreferences(user?.id ?? null);
	return json({ effective, global, user: userPrefs });
};

// PUT /api/settings/navigation?scope=global|user
/**
 * @openapi
 * summary: Update navigation preferences (landing page, env-click target) at global or per-user scope
 * query: scope:string Preference scope to update — "global" (default) or "user"
 * body: {landingPage:string, envClickPage:string}
 * body-example: {"landingPage":"containers","envClickPage":"logs"}
 * resp-200: The updated preferences ({success:true, global:{...}} for scope=global, or {success:true, user:{...}} for scope=user)
 * resp-400: Invalid input — invalid landingPage/envClickPage value, or scope=user requested while authentication is disabled
 * resp-401: Not authenticated (scope=user, authentication is enabled but no valid session)
 * resp-403: Permission denied (scope=global, requires settings:edit)
 */
export const PUT: RequestHandler = async ({ request, url, cookies }) => {
	const scope = url.searchParams.get('scope') ?? 'global';
	let patch: Partial<NavPreferences>;
	try {
		patch = parseNavPatch(await request.json());
	} catch (e) {
		return json({ error: e instanceof Error ? e.message : 'Invalid request' }, { status: 400 });
	}

	if (scope === 'user') {
		if (!(await isAuthEnabled())) return json({ error: 'Authentication is not enabled' }, { status: 400 });
		const user = await validateSession(cookies);
		if (!user) return json({ error: 'Not authenticated' }, { status: 401 });
		await setUserNavPreferences(user.id, patch);
		return json({ success: true, user: await getUserNavPreferences(user.id) });
	}

	// global scope — needs settings-edit permission (mirrors /api/settings/general POST)
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('settings', 'edit'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	await setGlobalNavPreferences(patch);
	return json({ success: true, global: await getGlobalNavPreferences() });
};
