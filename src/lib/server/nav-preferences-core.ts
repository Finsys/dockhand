/**
 * nav-preferences-core.ts — the PURE parts of the navigation preferences: the page allowlist
 * and the incoming-patch validation. No DB import, so it is unit-testable directly (importing
 * nav-preferences.ts pulls in db/drizzle -> better-sqlite3, which bun's test runner can't load).
 * nav-preferences.ts re-exports these so callers have one import site.
 */

export interface NavPreferences {
	landingPage: string | null;   // 'dashboard' | 'containers' | ... | null (=inherit/unset)
	envClickPage: string | null;  // where a Dashboard env-tile click goes
}

// The single list of pages the landing/env-click dropdowns can pick — the sidebar routes.
// ONE source of truth: the API validation allowlist and the NavigationSelector UI both use
// this, so a new page can't drift between "offered in the UI" and "accepted on save".
export const PAGE_SLUGS = [
	'dashboard', 'containers', 'logs', 'terminal', 'stacks', 'images', 'volumes', 'networks',
	'templates', 'registry', 'activity', 'backups', 'schedules', 'audit'
] as const;

/** Coerce + validate an incoming nav-prefs patch (pure). A field set to '' / null clears it
 * (inherit/none). Throws on an invalid page/env so the API returns 400. */
export function parseNavPatch(data: any): Partial<NavPreferences> {
	const out: Partial<NavPreferences> = {};
	if (data.landingPage !== undefined) {
		const p = data.landingPage;
		if (p === '' || p === null) out.landingPage = null;
		else if ((PAGE_SLUGS as readonly string[]).includes(p)) out.landingPage = p;
		else throw new Error('Invalid landingPage');
	}
	if (data.envClickPage !== undefined) {
		const p = data.envClickPage;
		// env-click is always a concrete page, never dashboard (you already clicked an env).
		if (p === '' || p === null) out.envClickPage = null;
		else if ((PAGE_SLUGS as readonly string[]).includes(p) && p !== 'dashboard') out.envClickPage = p;
		else throw new Error('Invalid envClickPage');
	}
	return out;
}
