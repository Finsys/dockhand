/**
 * Cross-site request protection for form-content writes, run from hooks.server.ts before auth.
 * SvelteKit's own check is disabled (csrf.trustedOrigins:['*'] in svelte.config.js) because it
 * compares against url.origin and cannot exempt the signature-authenticated endpoints below.
 *
 * Decision order: Sec-Fetch-Site when the browser sends it; otherwise the Origin header must
 * name the host the request was sent to; a trusted origin or exempt path overrides a rejection.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Content types a cross-site page can send without a CORS preflight. Anything else (JSON)
// needs a preflight that Dockhand never answers, so a browser cannot send it cross-site.
const FORM_CONTENT_TYPES = new Set([
	'application/x-www-form-urlencoded',
	'multipart/form-data',
	'text/plain'
]);

function isFormContentType(contentType: string | null): boolean {
	const type = (contentType || '').split(';', 1)[0].trim().toLowerCase();
	return type === '' || FORM_CONTENT_TYPES.has(type);
}

// Cross-origin by design and authenticated by a signature in the body: the OIDC back-channel
// logout token and the git webhook HMAC. Deliberately narrow - not the whole /api/auth/oidc
// prefix, whose admin CRUD must stay checked.
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
	/** The Origin header, null when absent. */
	origin: string | null;
	/** The Sec-Fetch-Site header, null when absent. Browsers send it to HTTPS and localhost. */
	secFetchSite: string | null;
	/** The Host header: the address the request was sent to. Not url.host, which follows ORIGIN. */
	host: string | null;
	isExemptPath: boolean;
	hasSessionCookie: boolean;
	/** The Authorization header carries a Bearer token (a token client). */
	hasBearerToken: boolean;
	/** Normalized origins (scheme://host[:port]) from TRUSTED_ORIGINS and ORIGIN. */
	trustedOrigins: ReadonlySet<string>;
	/** DISABLE_CSRF_ORIGIN_CHECK: the check is off entirely. */
	disabled: boolean;
}

// A URL with a host and no credentials, or null.
function parseOrigin(value: string): URL | null {
	try {
		const url = new URL(value);
		if (url.host === '' || url.username !== '' || url.password !== '') return null;
		return url;
	} catch {
		return null;
	}
}

function serializeOrigin(url: URL): string {
	return `${url.protocol}//${url.host}`;
}

function headerValue(value: string | null): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

/**
 * Parse TRUSTED_ORIGINS (comma-separated) plus the ORIGIN env into normalized origins. A full
 * origin is kept exactly; a bare host or host:port is trusted over both http and https. Entries
 * with a path, query, fragment or credentials, and anything unparseable, are dropped.
 */
export function parseTrustedOrigins(raw: string | null | undefined, appOrigin?: string | null): Set<string> {
	const out = new Set<string>();
	const add = (value: string) => {
		const url = parseOrigin(value);
		if (!url || url.pathname !== '/' || url.search !== '' || url.hash !== '') return;
		out.add(serializeOrigin(url));
	};
	for (const part of [...(raw ? raw.split(',') : []), appOrigin ?? '']) {
		const entry = part.trim();
		if (!entry) continue;
		if (entry.includes('://')) {
			add(entry);
			continue;
		}
		// A bare IPv6 literal (two or more colons, no brackets) has no port to split off.
		const host = !entry.startsWith('[') && (entry.match(/:/g)?.length ?? 0) >= 2 ? `[${entry}]` : entry;
		add(`http://${host}`);
		add(`https://${host}`);
	}
	return out;
}

/** Whether DISABLE_CSRF_ORIGIN_CHECK turns the check off (exactly 'true' or '1'). */
export function csrfOriginCheckDisabled(raw: string | null | undefined): boolean {
	return raw === 'true' || raw === '1';
}

/** True when the request must be rejected with 403. */
export function isForbiddenCrossOrigin(req: CsrfRequestInfo): boolean {
	if (req.disabled) return false;
	if (SAFE_METHODS.has(req.method.toUpperCase())) return false;
	if (!isFormContentType(req.contentType)) return false;
	// A page cannot add a Bearer header cross-site without a CORS preflight. Basic and other
	// HTTP auth schemes are excluded: a browser re-sends those on its own, e.g. to a proxy
	// with basic auth in front of Dockhand. A session cookie keeps the request checked.
	if (req.hasBearerToken && !req.hasSessionCookie) return false;

	const origin = headerValue(req.origin);
	const isExempt = () => {
		if (req.isExemptPath) return true;
		const url = origin ? parseOrigin(origin) : null;
		return url !== null && req.trustedOrigins.has(serializeOrigin(url));
	};

	switch (headerValue(req.secFetchSite)?.toLowerCase() ?? '') {
		case '':
			break;
		case 'same-origin':
		case 'none':
			return false;
		default:
			return !isExempt();
	}

	// Neither Sec-Fetch-Site nor Origin: not a browser form submission.
	if (origin === null) return false;

	const url = parseOrigin(origin);
	const host = headerValue(req.host);
	if (url && host) {
		// Read the Host header with the Origin's scheme so case and the default port normalize alike.
		const target = parseOrigin(`${url.protocol}//${host}`);
		// A proxy that passes Host without a port (nginx `$host` on 8080) cannot say which
		// port the page was on, so then the name alone has to match. A Host with a port
		// must match exactly.
		const hostHasPort = /:\d+$/.test(host);
		const sameTarget = target !== null && (target.host === url.host || (!hostHasPort && target.hostname === url.hostname));
		if (target && target.pathname === '/' && !target.search && !target.hash && sameTarget) return false;
	}
	return !isExempt();
}
