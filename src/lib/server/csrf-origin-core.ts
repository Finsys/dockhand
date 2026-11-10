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
	/** Operator escape hatches (from env, see parseTrustedHostnames / csrfOriginCheckDisabled):
	 * extra hostnames to treat as same-site (TRUSTED_ORIGINS), for a reverse proxy that rewrites
	 * the Origin hostname to something other than the app's own host. Empty by default. */
	trustedHostnames?: string[];
	/** True when the operator has turned the origin check off entirely (DISABLE_CSRF_ORIGIN_CHECK),
	 * a last-resort switch: no origin check runs and cross-site protection rests on the session
	 * cookie's SameSite attribute alone. */
	disabled?: boolean;
}

/** Parse the TRUSTED_ORIGINS env (CSV of hostnames or full origins) into a lowercased hostname
 * allowlist. A full origin (`https://app.example.com:8443`) is reduced to its hostname so the
 * entry matches the same way the check compares - by hostname, surviving scheme/port proxy
 * differences. Blank / unparseable entries are dropped (fail-safe: a bad value adds nothing,
 * never widens the allowlist to everything). */
export function parseTrustedHostnames(raw: string | null | undefined): string[] {
	if (!raw) return [];
	const out: string[] = [];
	for (const part of raw.split(',')) {
		const token = part.trim();
		if (!token) continue;
		// Accept a bare hostname or a full origin; reduce both to the hostname. Strip a trailing
		// :port only for a non-IPv6 token - a bare IPv6 literal (two or more colons) has no port
		// here and the regex would otherwise eat its last hextet (fe80::1 -> fe80:). A bracketed
		// or full-origin IPv6 goes through hostnameOf and keeps its brackets.
		const isBareIpv6 = !token.includes('://') && !token.startsWith('[') && (token.match(/:/g)?.length ?? 0) >= 2;
		const host = token.includes('://')
			? hostnameOf(token)
			: isBareIpv6 ? token.toLowerCase() : token.replace(/:\d+$/, '').toLowerCase();
		if (host) out.push(host.toLowerCase());
	}
	return out;
}

/** Whether the operator disabled the origin check entirely (DISABLE_CSRF_ORIGIN_CHECK truthy). */
export function csrfOriginCheckDisabled(raw: string | null | undefined): boolean {
	return raw === 'true' || raw === '1';
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
	// Operator kill switch: no origin check runs at all. A last-resort escape hatch for a
	// deployment the check breaks; with it on, cross-site protection rests on the session
	// cookie's SameSite attribute alone.
	if (req.disabled) return false;
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
	if (reqHost) {
		if (reqHost === hostnameOf(req.urlOrigin)) return false;
		// Operator allowlist (TRUSTED_ORIGINS): a reverse proxy may rewrite the Origin hostname
		// to a public name that differs from the app's own host; an operator can mark those
		// hostnames trusted so a legitimate browser form POST through such a proxy is not 403'd.
		if (req.trustedHostnames?.includes(reqHost.toLowerCase())) return false;
		return true;
	}
	// No Origin but cookie-authenticated: fall back to Sec-Fetch-Site, which a browser sets on
	// its own and an attacker cannot forge. same-origin/none is allowed; same-site/cross-site is
	// rejected. A request with NEITHER Origin NOR Sec-Fetch-Site is a non-browser client holding
	// a session cookie (a script, CI, the test runner): no browser cross-site mutating request
	// can have an empty-or-form content type AND no Origin AND no Sec-Fetch-Site (a form POST
	// always carries a non-empty content type and an Origin; a cross-site fetch is preflighted),
	// so that triple is not a forgeable shape - allow it. Matches Go net/http CrossOriginProtection.
	if (req.secFetchSite === 'same-origin' || req.secFetchSite === 'none') return false;
	if (!req.secFetchSite) return false;
	return true;
}
