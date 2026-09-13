// Navigation preferences (landing page + env-click target), stored as plain settings keys.
// GLOBAL = bare key; PER-USER = user:<id>:<key>. A per-user value of '' / null means "use the
// global default". Kept out of the (already huge) db.ts - it only leans on the generic settings
// get/set helpers.
import { getSetting, setSetting, setUserSetting } from './db.js';
// The type + patch validation live in a db-free core module so they stay unit-testable
// (importing this file pulls in db/drizzle -> better-sqlite3). Re-exported so the API route
// gets the type, parseNavPatch, and the db-backed getters/setters from one import site.
import { type NavPreferences, parseNavPatch } from './nav-preferences-core.js';
export { type NavPreferences, parseNavPatch };

async function readNav(scopeKey: (k: string) => string): Promise<NavPreferences> {
	const [page, click] = await Promise.all([
		getSetting(scopeKey('landing_page')),
		getSetting(scopeKey('env_click_page'))
	]);
	const s = (v: any) => (typeof v === 'string' && v.trim() !== '' ? v : null);
	return {
		landingPage: s(page),
		envClickPage: s(click)
	};
}

/** Global navigation defaults (whole instance). */
export async function getGlobalNavPreferences(): Promise<NavPreferences> {
	return readNav((k) => k);
}
export async function setGlobalNavPreferences(prefs: Partial<NavPreferences>): Promise<void> {
	const ups: Promise<void>[] = [];
	if (prefs.landingPage !== undefined) ups.push(setSetting('landing_page', prefs.landingPage ?? ''));
	if (prefs.envClickPage !== undefined) ups.push(setSetting('env_click_page', prefs.envClickPage ?? ''));
	await Promise.all(ups);
}

/** Per-user overrides. A null field inherits the global default. */
export async function getUserNavPreferences(userId: number): Promise<NavPreferences> {
	return readNav((k) => `user:${userId}:${k}`);
}
export async function setUserNavPreferences(userId: number, prefs: Partial<NavPreferences>): Promise<void> {
	const ups: Promise<void>[] = [];
	if (prefs.landingPage !== undefined) ups.push(setUserSetting(userId, 'landing_page', prefs.landingPage ?? ''));
	if (prefs.envClickPage !== undefined) ups.push(setUserSetting(userId, 'env_click_page', prefs.envClickPage ?? ''));
	await Promise.all(ups);
}

/** Effective navigation prefs for a request: per-user value wins, else global, else the default.
 * An unset landing page resolves to 'dashboard'. `userId` null (auth off / no user) uses global
 * only. NOTE: consumed by the client landing redirect + dashboard env-click. The NavigationSelector
 * UI reads the raw `global`/`user` views (where null still means inherit/unset), never this. */
export async function getEffectiveNavPreferences(userId: number | null): Promise<NavPreferences> {
	const global = await getGlobalNavPreferences();
	const user = userId == null ? null : await getUserNavPreferences(userId);
	const merged = user == null ? global : {
		landingPage: user.landingPage ?? global.landingPage,
		envClickPage: user.envClickPage ?? global.envClickPage
	};
	return {
		landingPage: merged.landingPage ?? 'dashboard',
		// Env-click is always a concrete view (default: containers).
		envClickPage: merged.envClickPage ?? 'containers'
	};
}
