/**
 * Which request paths skip authentication.
 *
 * Two lists, because they match differently. An exact entry covers only itself, so a
 * route added beneath one starts out protected like any other - a new
 * /api/license/<something> cannot be born unauthenticated by inheriting its parent's
 * entry. A prefix entry deliberately covers its subtree, for the few features whose
 * subtree IS the feature.
 *
 * Pure, so what the server lets through is a unit test rather than something only a
 * running instance can show.
 */

/** Public, and nothing beneath them. */
export const PUBLIC_EXACT = [
	'/login',
	'/api/auth/login',
	'/api/auth/logout',
	'/api/auth/session',
	'/api/auth/settings',
	'/api/auth/providers',
	'/api/auth/passkeys/login/options',
	'/api/auth/passkeys/login/verify',
	'/api/license',
	'/api/changelog',
	'/api/settings/theme'
];

/**
 * Public along with their subtree: the OIDC dance spans several callbacks, the docs
 * page loads its own viewer, and the health probes include /api/health/database,
 * which redacts its own payload by permission.
 */
export const PUBLIC_PREFIXES = ['/api/auth/oidc', '/api/docs', '/api/health'];

/**
 * Endpoints carrying their own authentication - a signature or a shared secret - so
 * they must not be answered from a session either way.
 */
export const PUBLIC_PATH_PATTERNS = [
	/^\/api\/git\/stacks\/\d+\/webhook$/,
	/^\/api\/git\/webhook\/\d+$/
];

/** Whether this path is reachable without a session. */
export function isPublicPath(pathname: string): boolean {
	if (PUBLIC_PATH_PATTERNS.some((re) => re.test(pathname))) return true;
	if (PUBLIC_EXACT.includes(pathname)) return true;
	return PUBLIC_PREFIXES.some((path) => pathname === path || pathname.startsWith(path + '/'));
}
