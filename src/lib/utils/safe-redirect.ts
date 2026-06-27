/**
 * Path-relative redirect target validation.
 *
 * Returns true only for targets that are path-relative URLs ('/path?query#hash').
 * Rejects absolute URLs ('https://...', 'http://...'), protocol-relative URLs
 * ('//example.com'), backslash-prefixed forms ('\\example.com' — some browsers
 * normalize these), and non-string inputs.
 */
export function isSafeRedirect(target: unknown): target is string {
	if (typeof target !== 'string' || target.length === 0) return false;
	if (!target.startsWith('/')) return false;
	if (target.startsWith('//') || target.startsWith('/\\')) return false;
	return true;
}

/**
 * Return the input when it passes isSafeRedirect, otherwise '/'. Use this on
 * any post-login / post-callback redirect target derived from user input.
 */
export function safeRedirectOrRoot(target: unknown): string {
	return isSafeRedirect(target) ? target : '/';
}
