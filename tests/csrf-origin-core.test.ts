import { describe, test, expect } from 'bun:test';
import { isForbiddenCrossOrigin, isCsrfExemptPath, parseTrustedHostnames, csrfOriginCheckDisabled } from '../src/lib/server/csrf-origin-core';

const SELF = 'https://dockhand.example.com';
// Default request shape for a cookie-authenticated browser request (the CSRF-eligible case).
const base = { urlOrigin: SELF, isExemptPath: false, hasSessionCookie: true, secFetchSite: null as string | null };

describe('isForbiddenCrossOrigin - cookie-authenticated (the CSRF-eligible path)', () => {
	test('cross-origin form-content writes are forbidden', () => {
		for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) {
			for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
				expect(isForbiddenCrossOrigin({ ...base, method, contentType: ct, origin: 'https://evil.com' })).toBe(true);
			}
		}
	});

	test('cross-origin JSON write is NOT forbidden (not a form content type)', () => {
		// The app's own UI mutations are application/json; this is why they are never caught.
		expect(isForbiddenCrossOrigin({ ...base, method: 'POST', contentType: 'application/json', origin: 'https://evil.com' })).toBe(false);
	});

	test('same-origin form write is NOT forbidden', () => {
		expect(isForbiddenCrossOrigin({ ...base, method: 'POST', contentType: 'text/plain', origin: SELF })).toBe(false);
	});

	test('same-hostname but scheme/port mismatch is NOT forbidden (plain-HTTP / TLS-proxy case)', () => {
		// adapter-node defaults url.origin scheme to https when ORIGIN is unset, and a
		// TLS-terminating proxy maps the public port to the app's, so a plain-HTTP or
		// different-port browser Origin must not be rejected as cross-site.
		expect(isForbiddenCrossOrigin({ ...base, urlOrigin: 'https://host:3000', method: 'POST', contentType: 'multipart/form-data', origin: 'http://host:3000' })).toBe(false);
		expect(isForbiddenCrossOrigin({ ...base, urlOrigin: 'https://dockhand.lan', method: 'POST', contentType: '', origin: 'http://dockhand.lan' })).toBe(false);
		expect(isForbiddenCrossOrigin({ ...base, urlOrigin: 'https://dockhand.lan:3000', method: 'POST', contentType: 'text/plain', origin: 'https://dockhand.lan' })).toBe(false);
	});

	test('different HOST form write IS forbidden even on matching scheme', () => {
		expect(isForbiddenCrossOrigin({ ...base, urlOrigin: 'https://dockhand.lan', method: 'POST', contentType: 'text/plain', origin: 'https://evil.lan' })).toBe(true);
	});

	test('cross-origin GET/HEAD is NOT forbidden (not a mutating method)', () => {
		expect(isForbiddenCrossOrigin({ ...base, method: 'GET', contentType: 'text/plain', origin: 'https://evil.com' })).toBe(false);
	});

	test('text/plain with charset is still treated as form content', () => {
		expect(isForbiddenCrossOrigin({ ...base, method: 'POST', contentType: 'text/plain; charset=utf-8', origin: 'https://evil.com' })).toBe(true);
	});
});

describe('isForbiddenCrossOrigin - NO session cookie (not a CSRF target -> always allowed)', () => {
	// The regression this fixes: a request with no session cookie carries no ambient
	// credential to forge against, so it cannot be a cross-site forgery whatever its shape.
	// This is the CI/CD runner (bare POST, no Origin, no content-type), curl scripts, a
	// bearer/API client, and an auth-disabled single-user install. All must pass.
	test('bare POST (no Origin, no content-type, no cookie) is NOT forbidden - the CI runner shape', () => {
		expect(isForbiddenCrossOrigin({ ...base, hasSessionCookie: false, method: 'POST', contentType: null, origin: null })).toBe(false);
	});

	test('cross-origin form POST with NO cookie is NOT forbidden (no cookie = no CSRF)', () => {
		// Even an evil-looking cross-host form POST is harmless without a cookie to ride.
		expect(isForbiddenCrossOrigin({ ...base, hasSessionCookie: false, method: 'POST', contentType: 'text/plain', origin: 'https://evil.com' })).toBe(false);
	});

	test('bearer client (no cookie) with junk content-type is NOT forbidden', () => {
		expect(isForbiddenCrossOrigin({ ...base, hasSessionCookie: false, method: 'DELETE', contentType: 'application/x-www-form-urlencoded', origin: null })).toBe(false);
	});
});

describe('isForbiddenCrossOrigin - cookie-authed with NO Origin: Sec-Fetch-Site decides (fail closed)', () => {
	test('Sec-Fetch-Site same-origin / none is allowed', () => {
		expect(isForbiddenCrossOrigin({ ...base, method: 'POST', contentType: 'text/plain', origin: null, secFetchSite: 'same-origin' })).toBe(false);
		expect(isForbiddenCrossOrigin({ ...base, method: 'POST', contentType: 'text/plain', origin: null, secFetchSite: 'none' })).toBe(false);
	});

	test('Sec-Fetch-Site cross-site / same-site is forbidden', () => {
		expect(isForbiddenCrossOrigin({ ...base, method: 'POST', contentType: 'text/plain', origin: null, secFetchSite: 'cross-site' })).toBe(true);
		expect(isForbiddenCrossOrigin({ ...base, method: 'POST', contentType: 'text/plain', origin: null, secFetchSite: 'same-site' })).toBe(true);
	});

	test('cookie-authed request with NEITHER Origin NOR Sec-Fetch-Site is ALLOWED (non-browser client)', () => {
		// No browser cross-site mutating request can have no Origin AND no Sec-Fetch-Site: a form
		// POST always carries an Origin, a cross-site fetch is preflighted. So this triple is a
		// non-browser client holding a session cookie (script/CI/test runner), not a forgery.
		expect(isForbiddenCrossOrigin({ ...base, method: 'POST', contentType: 'text/plain', origin: null, secFetchSite: null })).toBe(false);
	});

	test('bodyless cookie DELETE with no Origin, no content-type, no Sec-Fetch-Site is ALLOWED (the build-5957 shape)', () => {
		// The exact shape the integration suite sends: a session cookie, a bodyless DELETE (so no
		// Content-Type), and a server-side fetch that attaches neither Origin nor Sec-Fetch-Site.
		// Empty content-type is form-reachable, so this previously fell through to a 403.
		expect(isForbiddenCrossOrigin({ ...base, method: 'DELETE', contentType: null, origin: null, secFetchSite: null })).toBe(false);
		expect(isForbiddenCrossOrigin({ ...base, method: 'POST', contentType: null, origin: null, secFetchSite: null })).toBe(false);
	});

	test('Sec-Fetch-Site is ignored when an Origin is present (hostname decides)', () => {
		// A same-host Origin wins even if a (spoofable-looking) Sec-Fetch-Site says cross-site;
		// the host comparison is the stronger signal when Origin is there.
		expect(isForbiddenCrossOrigin({ ...base, method: 'POST', contentType: 'text/plain', origin: SELF, secFetchSite: 'cross-site' })).toBe(false);
	});
});

describe('isForbiddenCrossOrigin - exempt paths', () => {
	test('no-Origin form POST on an EXEMPT path is allowed (IdP/webhook server-to-server)', () => {
		// The OIDC back-channel logout and git webhooks POST form-encoded with no browser
		// Origin and may carry no cookie; they must NOT be 403'd.
		expect(isForbiddenCrossOrigin({ ...base, method: 'POST', contentType: 'application/x-www-form-urlencoded', origin: null, isExemptPath: true })).toBe(false);
		// Exempt wins even for a cookie-authed, no-Sec-Fetch-Site request.
		expect(isForbiddenCrossOrigin({ ...base, method: 'POST', contentType: 'text/plain', origin: 'https://evil.com', isExemptPath: true })).toBe(false);
	});
});

describe('isCsrfExemptPath', () => {
	test('exempts the signature-authenticated cross-origin paths only', () => {
		expect(isCsrfExemptPath('/api/auth/oidc/backchannel-logout')).toBe(true);
		expect(isCsrfExemptPath('/api/git/webhook/42')).toBe(true);
		expect(isCsrfExemptPath('/api/git/stacks/7/webhook')).toBe(true);
	});

	test('does NOT exempt the OIDC admin CRUD under the same prefix', () => {
		expect(isCsrfExemptPath('/api/auth/oidc')).toBe(false);
		expect(isCsrfExemptPath('/api/auth/oidc/1')).toBe(false);
		expect(isCsrfExemptPath('/api/auth/oidc/1/test')).toBe(false);
		expect(isCsrfExemptPath('/api/auth/oidc/1/initiate')).toBe(false);
	});

	test('does not exempt an unrelated path', () => {
		expect(isCsrfExemptPath('/api/stacks/x/stop')).toBe(false);
		expect(isCsrfExemptPath('/api/git/webhook/abc')).toBe(false); // non-numeric id
	});
});

describe('operator escape hatches', () => {
	// The exact attack the check blocks by default: cookie-authed cross-host form POST.
	const attack = { ...base, method: 'POST', contentType: 'text/plain', origin: 'https://proxy-rewritten.example.net' };

	test('without the hatches, a cross-host form POST stays 403', () => {
		expect(isForbiddenCrossOrigin(attack)).toBe(true);
	});

	test('TRUSTED_ORIGINS hostname allows an Origin a proxy rewrote to that host', () => {
		expect(isForbiddenCrossOrigin({ ...attack, trustedHostnames: ['proxy-rewritten.example.net'] })).toBe(false);
		// case-insensitive, and only the LISTED host is trusted - a different cross-host still 403s.
		expect(isForbiddenCrossOrigin({ ...attack, origin: 'https://PROXY-Rewritten.Example.NET', trustedHostnames: ['proxy-rewritten.example.net'] })).toBe(false);
		expect(isForbiddenCrossOrigin({ ...attack, origin: 'https://evil.com', trustedHostnames: ['proxy-rewritten.example.net'] })).toBe(true);
	});

	test('the allowlist is EXACT host match, not a suffix/prefix substring (bypass guard)', () => {
		const trusted = ['proxy-rewritten.example.net'];
		// A suffix attack: attacker.com owns a subdomain that ends with the trusted host text.
		expect(isForbiddenCrossOrigin({ ...attack, origin: 'https://proxy-rewritten.example.net.attacker.com', trustedHostnames: trusted })).toBe(true);
		// A prefix attack: a host that starts with the trusted text.
		expect(isForbiddenCrossOrigin({ ...attack, origin: 'https://evil-proxy-rewritten.example.net', trustedHostnames: trusted })).toBe(true);
		// A bare substring anywhere.
		expect(isForbiddenCrossOrigin({ ...attack, origin: 'https://x-proxy-rewritten.example.net-y.evil.com', trustedHostnames: trusted })).toBe(true);
	});

	test('DISABLE_CSRF_ORIGIN_CHECK turns the whole check off (pre-1.0.57 behavior)', () => {
		expect(isForbiddenCrossOrigin({ ...attack, disabled: true })).toBe(false);
		// Even a no-cookie / exempt combination is unaffected - disabled short-circuits first.
		expect(isForbiddenCrossOrigin({ ...attack, disabled: true, secFetchSite: 'cross-site' })).toBe(false);
	});

	test('the hatches never widen past their input: empty list / absent flag keep the default 403', () => {
		expect(isForbiddenCrossOrigin({ ...attack, trustedHostnames: [] })).toBe(true);
		expect(isForbiddenCrossOrigin({ ...attack, disabled: false })).toBe(true);
	});
});

describe('parseTrustedHostnames', () => {
	test('CSV of bare hostnames, lowercased and trimmed', () => {
		expect(parseTrustedHostnames('a.example.com, B.Example.com ,c.test')).toEqual(['a.example.com', 'b.example.com', 'c.test']);
	});

	test('a full origin is reduced to its hostname (so it matches the hostname compare)', () => {
		expect(parseTrustedHostnames('https://app.example.com:8443')).toEqual(['app.example.com']);
		expect(parseTrustedHostnames('host.example.com:3000')).toEqual(['host.example.com']);
	});

	test('a bare IPv6 literal keeps all its hextets (the :port strip must not eat the last one)', () => {
		// A URL Origin for an IPv6 host is bracketed, so a bare entry must stay intact to match it
		// via the full-origin form; the regression was fe80::1 -> fe80: which trusts nothing.
		expect(parseTrustedHostnames('fe80::1')).toEqual(['fe80::1']);
		expect(parseTrustedHostnames('2001:db8::1')).toEqual(['2001:db8::1']);
		// A bracketed / full-origin IPv6 reduces to the bracketed hostname URL reports.
		expect(parseTrustedHostnames('https://[fe80::1]:9000')).toEqual(['[fe80::1]']);
	});

	test('blank / empty / unparseable entries are dropped (fail-safe: never widen to everything)', () => {
		expect(parseTrustedHostnames('')).toEqual([]);
		expect(parseTrustedHostnames(null)).toEqual([]);
		expect(parseTrustedHostnames(undefined)).toEqual([]);
		expect(parseTrustedHostnames('  ,  , ')).toEqual([]);
		expect(parseTrustedHostnames('https://')).toEqual([]);
	});
});

describe('csrfOriginCheckDisabled', () => {
	test('only an explicit true/1 disables', () => {
		expect(csrfOriginCheckDisabled('true')).toBe(true);
		expect(csrfOriginCheckDisabled('1')).toBe(true);
		expect(csrfOriginCheckDisabled('false')).toBe(false);
		expect(csrfOriginCheckDisabled('0')).toBe(false);
		expect(csrfOriginCheckDisabled('')).toBe(false);
		expect(csrfOriginCheckDisabled(null)).toBe(false);
		expect(csrfOriginCheckDisabled('TRUE')).toBe(false); // exact match only, no accidental enabling
	});
});
