import { describe, test, expect } from 'bun:test';
import { isForbiddenCrossOrigin, isCsrfExemptPath } from '../src/lib/server/csrf-origin-core';

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

	test('cookie-authed form POST with NEITHER Origin NOR Sec-Fetch-Site is forbidden (fail closed)', () => {
		// A legacy browser or a header-stripping proxy carrying a session cookie - portainer's
		// conservative choice. A non-browser client would have no cookie (covered above).
		expect(isForbiddenCrossOrigin({ ...base, method: 'POST', contentType: 'text/plain', origin: null, secFetchSite: null })).toBe(true);
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
