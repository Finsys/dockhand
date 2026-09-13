/**
 * Pure decisions behind the theme toggles. Kept out of theme.ts and the .svelte
 * components (which touch localStorage/document/fetch) so they are unit-testable.
 */

/**
 * The value a toggle should display: the global default when one is provided (the
 * General settings editor), otherwise the personal value from the theme store.
 */
export function resolveToggleValue(globalValue: boolean | undefined, storeValue: boolean): boolean {
	return globalValue !== undefined ? globalValue : storeValue;
}

/**
 * Where setPreference persists: a per-user PUT to the profile when a userId is given,
 * otherwise a POST to the global settings default (the default for new users).
 */
export function preferenceTarget(userId?: number): { url: string; method: 'PUT' | 'POST' } {
	return userId
		? { url: '/api/profile/preferences', method: 'PUT' }
		: { url: '/api/settings/general', method: 'POST' };
}

/**
 * Whether to skip applying the change to the live document. Editing the global default
 * (no userId) with auth on persists without changing the current admin's own view, whose
 * per-user preference drives their session. Auth state still loading also skips.
 */
export function shouldSkipApply(authLoading: boolean, authEnabled: boolean, userId?: number): boolean {
	if (authLoading) return true;
	return authEnabled && !userId;
}
