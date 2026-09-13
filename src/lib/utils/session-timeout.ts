/**
 * Resolve the effective session lifetime (seconds) from the configured value.
 * 0 is the "never expire" sentinel (#1302): the session still lives in the DB
 * (logout, password change and deactivation delete it) but is dated ~10 years out
 * so time never ends it. Any invalid value falls back to the 24h default. Pure so
 * it can be unit-tested without the DB.
 */

export const MAX_SESSION_TIMEOUT = 2592000; // 30 days in seconds
export const DEFAULT_SESSION_TIMEOUT = 86400; // 24 hours in seconds
export const NEVER_EXPIRE_TIMEOUT = 315360000; // 10 years in seconds
// Browsers (Chrome 104+, Firefox) clamp Set-Cookie max-age to ~400 days (RFC 6265bis),
// so a longer cookie is pointless. The DB session can outlive this; the cookie caps here.
export const MAX_COOKIE_MAX_AGE = 34560000; // 400 days in seconds

export function resolveSessionTimeout(configured: number | null | undefined): number {
	if (configured === 0) return NEVER_EXPIRE_TIMEOUT;
	if (typeof configured === 'number' && configured > 0 && configured <= MAX_SESSION_TIMEOUT) {
		return configured;
	}
	return DEFAULT_SESSION_TIMEOUT;
}

/**
 * The cookie max-age to use for a given server-side session lifetime. Capped at the
 * browser's ~400-day limit so cookie and DB lifetimes don't silently diverge for a
 * never-expire session (the DB row still lives its full lifetime).
 */
export function cookieMaxAge(sessionTimeout: number): number {
	return Math.min(sessionTimeout, MAX_COOKIE_MAX_AGE);
}
