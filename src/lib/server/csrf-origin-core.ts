/**
 * Own CSRF origin check, replacing SvelteKit's built-in one (disabled via
 * csrf.trustedOrigins:['*'] in svelte.config.js) so public cross-origin endpoints that
 * authenticate by signature - the OIDC back-channel logout token and the git webhook
 * HMAC - can be exempted. SvelteKit's check runs inside respond() before any handle
 * hook, so a per-path exemption is only possible by owning the check here.
 *
 * Same policy as SvelteKit: reject a form-content mutating request whose Origin is not
 * the server's own. application/json is not a form content type, so the app's own JSON
 * UI calls are never caught; a browser form-POST from another site is.
 */

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// The content types a cross-site HTML form / no-preflight fetch can send. A match here
// is what makes a forged write reachable without a CORS preflight.
const FORM_CONTENT_TYPES = new Set([
	'application/x-www-form-urlencoded',
	'multipart/form-data',
	'text/plain'
]);

function isFormContentType(contentType: string | null): boolean {
	const type = (contentType || '').split(';', 1)[0].trim().toLowerCase();
	// An empty content type is form-reachable too (a bodyless form submit), matching
	// SvelteKit's is_form_content_type.
	return type === '' || FORM_CONTENT_TYPES.has(type);
}

// Paths that are cross-origin BY DESIGN and authenticate by a signature in the body, not
// by the browser Origin: the OIDC back-channel logout token, and the git webhook HMAC.
// A browser never initiates these, so the origin check would only ever block the real
// server-to-server caller. Deliberately NARROW - not the whole /api/auth/oidc prefix,
// whose admin CRUD must stay origin-checked.
const CSRF_EXEMPT_EXACT = new Set(['/api/auth/oidc/backchannel-logout']);
const CSRF_EXEMPT_PATTERNS = [
	/^\/api\/git\/stacks\/\d+\/webhook$/,
	/^\/api\/git\/webhook\/\d+$/
];

export function isCsrfExemptPath(pathname: string): boolean {
	return CSRF_EXEMPT_EXACT.has(pathname) || CSRF_EXEMPT_PATTERNS.some((re) => re.test(pathname));
}

export interface CsrfRequestInfo {
	method: string;
	contentType: string | null;
	origin: string | null;
	urlOrigin: string;
	/** True when the path is public-by-design and authenticates without a browser origin
	 * (OIDC back-channel logout, git webhooks) - exempt from the origin check. */
	isExemptPath: boolean;
	/** True when a session cookie is present. CSRF only exists for cookie-authenticated
	 * requests: a browser attaches the session cookie automatically on a cross-site form
	 * POST, which is the whole attack. A request with NO session cookie carries no ambient
	 * credential to forge against - a CI/CD bearer client, a curl script, or an auth-disabled
	 * single-user install - so it is never a CSRF target and is allowed regardless of Origin.
	 * (Go's net/http CrossOriginProtection and portainer use the same rule.) */
	hasSessionCookie: boolean;
	/** The browser-set Sec-Fetch-Site metadata header, used to decide a cookie-authenticated
	 * request that carries no Origin. A browser always sends it on a navigation/fetch
	 * ('same-origin' | 'same-site' | 'cross-site' | 'none'); a cross-site attacker cannot
	 * forge or strip it from a form POST. A non-browser client omits it. Null when absent. */
	secFetchSite: string | null;
}

// hostname (no port): a TLS-terminating proxy maps the public :443 to the app's :3000, so
// the browser Origin and url.origin legitimately differ by port as well as scheme. A
// genuine cross-site attacker has a different hostname, which is what we gate on.
function hostnameOf(url: string | null): string | null {
	if (!url) return null;
	try {
		return new URL(url).hostname;
	} catch {
		return null;
	}
}

/** True when the request is a cross-site form-content write that must be rejected 403. */
export function isForbiddenCrossOrigin(req: CsrfRequestInfo): boolean {
	if (req.isExemptPath) return false;
	if (!MUTATING.has(req.method)) return false;
	if (!isFormContentType(req.contentType)) return false;
	// CSRF targets the ambient session cookie. With NO session cookie there is nothing to
	// forge against, so the request cannot be a cross-site forgery whatever its Origin: this
	// is the CI/CD bearer client, the curl/script path (no Origin, often no form content
	// type), and the auth-disabled single-user install. Allow it. Only a cookie-authenticated
	// request can be a CSRF victim, and only that is checked below.
	if (!req.hasSessionCookie) return false;
	// Origin present: compare HOSTNAME, not full origin. Behind a TLS-terminating proxy, or on
	// a plain-HTTP deployment with ORIGIN unset, adapter-node defaults url.origin's scheme to
	// https and the proxy maps the public port to the app's, so a legitimate browser Origin
	// differs by scheme and port - mismatches that must NOT be treated as cross-site (that
	// false 403 would break file upload and logout). A genuine attacker has a different host.
	const reqHost = hostnameOf(req.origin);
	if (reqHost) return reqHost !== hostnameOf(req.urlOrigin);
	// No Origin but cookie-authenticated: fall back to Sec-Fetch-Site, which a browser sets on
	// its own and an attacker cannot forge. same-origin/none (a direct navigation or a
	// same-origin fetch) is allowed; same-site/cross-site is rejected. A request with neither
	// Origin nor Sec-Fetch-Site is a legacy browser or a header-stripping proxy carrying a
	// cookie - fail CLOSED (reject), matching portainer.
	if (req.secFetchSite === 'same-origin' || req.secFetchSite === 'none') return false;
	return true;
}
