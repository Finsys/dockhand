import { describe, test, expect } from 'bun:test';
import {
	isForbiddenCrossOrigin,
	isForbiddenCrossOriginUpgrade,
	isCsrfExemptPath,
	parseTrustedOrigins,
	csrfOriginCheckDisabled,
	type CsrfRequestInfo
} from '../src/lib/server/csrf-origin-core';

// A browser form POST to Dockhand on its LAN address over plain HTTP (no Sec-Fetch-Site).
const base: CsrfRequestInfo = {
	method: 'POST',
	contentType: 'text/plain',
	origin: 'http://192.168.1.50:3000',
	secFetchSite: null,
	host: '192.168.1.50:3000',
	isExemptPath: false,
	hasSessionCookie: true,
	hasBearerToken: false,
	trustedOrigins: new Set(),
	disabled: false
};
const req = (over: Partial<CsrfRequestInfo>) => isForbiddenCrossOrigin({ ...base, ...over });

describe('isForbiddenCrossOrigin - what is checked', () => {
	test('safe methods pass', () => {
		for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
			expect(req({ method, origin: 'https://evil.com' })).toBe(false);
		}
	});

	test('every unsafe method with a form content type is checked', () => {
		for (const contentType of ['text/plain', 'text/plain; charset=utf-8', 'text/plain ;charset=utf-8', ' multipart/form-data; boundary=x', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'TEXT/PLAIN', '', null]) {
			for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
				expect(req({ method, contentType, origin: 'https://evil.com' })).toBe(true);
			}
		}
	});

	test('a JSON write is left to CORS (a cross-site page cannot send it without a preflight)', () => {
		expect(req({ contentType: 'application/json', origin: 'https://evil.com' })).toBe(false);
		expect(req({ contentType: 'application/json', origin: 'https://evil.com', secFetchSite: 'cross-site' })).toBe(false);
	});

	test('DISABLE_CSRF_ORIGIN_CHECK turns the check off', () => {
		expect(req({ origin: 'https://evil.com', secFetchSite: 'cross-site', disabled: true })).toBe(false);
	});
});

describe('isForbiddenCrossOrigin - token clients', () => {
	test('a Bearer token without a session cookie passes', () => {
		expect(req({ hasSessionCookie: false, hasBearerToken: true, origin: 'https://evil.com' })).toBe(false);
		expect(req({ hasSessionCookie: false, hasBearerToken: true, origin: 'https://evil.com', secFetchSite: 'cross-site' })).toBe(false);
	});

	test('a session cookie keeps the request checked even with a Bearer token', () => {
		expect(req({ hasBearerToken: true, origin: 'https://evil.com' })).toBe(true);
	});

	test('browser-sent HTTP auth (Basic to a proxy) is not a token: a cross-site form is forbidden', () => {
		// hasBearerToken is false for Basic; the browser attaches it on its own.
		expect(req({ hasSessionCookie: false, hasBearerToken: false, origin: 'https://evil.com', secFetchSite: 'cross-site' })).toBe(true);
	});
});

describe('isForbiddenCrossOrigin - Sec-Fetch-Site (sent to HTTPS and localhost)', () => {
	test('same-origin and none pass, whatever the Origin', () => {
		expect(req({ secFetchSite: 'same-origin', origin: 'https://evil.com' })).toBe(false);
		expect(req({ secFetchSite: 'none', origin: null })).toBe(false);
		expect(req({ secFetchSite: 'Same-Origin' })).toBe(false);
	});

	test('same-site and cross-site are forbidden, with or without a session cookie', () => {
		for (const hasSessionCookie of [true, false]) {
			// Another port of the same host is same-site and its host matches nothing else here.
			expect(req({ hasSessionCookie, secFetchSite: 'same-site', origin: 'http://192.168.1.50:8080' })).toBe(true);
			expect(req({ hasSessionCookie, secFetchSite: 'cross-site', origin: 'https://evil.com' })).toBe(true);
			// The verdict stands even when the Origin names the requested host.
			expect(req({ hasSessionCookie, secFetchSite: 'cross-site' })).toBe(true);
			// An unknown value is not same-origin.
			expect(req({ hasSessionCookie, secFetchSite: 'bogus' })).toBe(true);
		}
	});

	test('a trusted origin passes only on an exact match, port and scheme included', () => {
		const trustedOrigins = new Set(['https://portal.example.com']);
		expect(req({ secFetchSite: 'cross-site', origin: 'https://portal.example.com', trustedOrigins })).toBe(false);
		expect(req({ secFetchSite: 'same-site', origin: 'https://portal.example.com:8443', trustedOrigins })).toBe(true);
		expect(req({ secFetchSite: 'cross-site', origin: 'http://portal.example.com', trustedOrigins })).toBe(true);
		expect(req({ secFetchSite: 'cross-site', origin: 'https://evil-portal.example.com', trustedOrigins })).toBe(true);
		expect(req({ secFetchSite: 'cross-site', origin: null, trustedOrigins })).toBe(true);
	});

	test('an exempt path passes', () => {
		expect(req({ secFetchSite: 'cross-site', origin: 'https://idp.example.com', isExemptPath: true })).toBe(false);
	});
});

describe('isForbiddenCrossOrigin - without Sec-Fetch-Site (plain HTTP)', () => {
	test('no Origin passes: not a browser form submission (CI, curl, scripts)', () => {
		for (const hasSessionCookie of [true, false]) {
			expect(req({ hasSessionCookie, origin: null, contentType: null })).toBe(false);
			expect(req({ hasSessionCookie, origin: '  ', method: 'DELETE' })).toBe(false);
		}
	});

	test('an Origin naming the requested host passes, with or without a cookie', () => {
		for (const hasSessionCookie of [true, false]) {
			expect(req({ hasSessionCookie })).toBe(false);
		}
	});

	test('a foreign Origin is forbidden, with or without a cookie (auth disabled)', () => {
		for (const hasSessionCookie of [true, false]) {
			expect(req({ hasSessionCookie, origin: 'https://evil.com' })).toBe(true);
		}
	});

	test('the host match includes the port', () => {
		expect(req({ origin: 'http://192.168.1.50:8080' })).toBe(true);
		expect(req({ origin: 'http://192.168.1.50' })).toBe(true);
		expect(req({ origin: 'http://192.168.1.5:3000' })).toBe(true);
		expect(req({ origin: 'http://192.168.1.50.evil.com:3000' })).toBe(true);
	});

	test('case and the default port normalize; the default port follows the Origin scheme', () => {
		expect(req({ host: 'NAS.lan:80', origin: 'http://nas.lan' })).toBe(false);
		expect(req({ host: 'nas.lan:443', origin: 'https://nas.lan' })).toBe(false);
		expect(req({ host: 'nas.lan', origin: 'https://NAS.lan:443' })).toBe(false);
		expect(req({ host: 'nas.lan:443', origin: 'http://nas.lan' })).toBe(true);
	});

	test('a Host without a port (nginx $host on a custom port) matches by name alone', () => {
		for (const hasSessionCookie of [true, false]) {
			expect(req({ hasSessionCookie, host: 'dh.lan', origin: 'http://dh.lan:8080' })).toBe(false);
		}
		expect(req({ host: '[fd00::5]', origin: 'http://[fd00::5]:8080' })).toBe(false);
		// The name still has to match, and a Host that names a port still must match it.
		expect(req({ host: 'dh.lan', origin: 'http://evil.lan:8080' })).toBe(true);
		expect(req({ host: 'dh.lan', origin: 'http://dh.lan.evil.com:8080' })).toBe(true);
		expect(req({ host: 'dh.lan:3000', origin: 'http://dh.lan:8080' })).toBe(true);
		expect(req({ host: '[fd00::5]:3000', origin: 'http://[fd00::5]:8080' })).toBe(true);
	});

	test('IPv6 literals match exactly', () => {
		expect(req({ host: '[fd00::5]:3000', origin: 'http://[fd00::5]:3000' })).toBe(false);
		expect(req({ host: '[fd00::5]:3000', origin: 'http://[fd00::6]:3000' })).toBe(true);
	});

	test('an Origin that does not parse is forbidden (Origin: null from a sandbox or redirect)', () => {
		for (const hasSessionCookie of [true, false]) {
			expect(req({ hasSessionCookie, origin: 'null' })).toBe(true);
			expect(req({ hasSessionCookie, origin: 'not a url' })).toBe(true);
		}
	});

	test('a Host header that does not parse or carries credentials matches nothing', () => {
		expect(req({ host: null })).toBe(true);
		expect(req({ host: 'user@192.168.1.50:3000' })).toBe(true);
		expect(req({ host: '192.168.1.50:3000/x' })).toBe(true);
		expect(req({ host: '192.168.1.50:3000?x' })).toBe(true);
		expect(req({ host: '192.168.1.50:3000#x' })).toBe(true);
	});

	test('a proxy that rewrites Host: the ORIGIN / TRUSTED_ORIGINS entry passes', () => {
		const proxied = { host: '127.0.0.1:3000', origin: 'https://dockhand.example.com', trustedOrigins: new Set(['https://dockhand.example.com']) };
		expect(req(proxied)).toBe(false);
		expect(req({ ...proxied, origin: 'https://dockhand.example.com:8443' })).toBe(true);
		expect(req({ ...proxied, trustedOrigins: new Set() })).toBe(true);
	});

	test('an exempt path passes', () => {
		expect(req({ origin: 'https://idp.example.com', isExemptPath: true })).toBe(false);
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
		expect(isCsrfExemptPath('/api/git/webhook/abc')).toBe(false);
		expect(isCsrfExemptPath('/api/git/stacks/7/webhook/x')).toBe(false);
		expect(isCsrfExemptPath('/api/git/stacks/7/webhooks')).toBe(false);
		expect(isCsrfExemptPath('/x/api/git/webhook/1')).toBe(false);
		expect(isCsrfExemptPath('/api/git/webhook/1/x')).toBe(false);
	});
});

describe('parseTrustedOrigins', () => {
	test('a full origin is kept exactly, normalized', () => {
		expect([...parseTrustedOrigins('https://App.Example.com:8443/')]).toEqual(['https://app.example.com:8443']);
		expect([...parseTrustedOrigins('https://app.example.com:443')]).toEqual(['https://app.example.com']);
	});

	test('a bare host or host:port is trusted over http and https', () => {
		expect([...parseTrustedOrigins('a.example.com, B.Example.com:3000')]).toEqual([
			'http://a.example.com',
			'https://a.example.com',
			'http://b.example.com:3000',
			'https://b.example.com:3000'
		]);
	});

	test('a bare IPv6 literal keeps every hextet', () => {
		expect([...parseTrustedOrigins('fe80::1')]).toEqual(['http://[fe80::1]', 'https://[fe80::1]']);
		expect([...parseTrustedOrigins('[fe80::1]:9000')]).toEqual(['http://[fe80::1]:9000', 'https://[fe80::1]:9000']);
		expect([...parseTrustedOrigins('https://[fe80::1]:9000')]).toEqual(['https://[fe80::1]:9000']);
	});

	test('ORIGIN is added to the list', () => {
		expect([...parseTrustedOrigins(undefined, 'https://dockhand.example.com')]).toEqual(['https://dockhand.example.com']);
		expect([...parseTrustedOrigins('a.lan', 'https://dockhand.example.com')]).toContain('https://dockhand.example.com');
	});

	test('blank, unparseable and non-origin entries are dropped', () => {
		expect([...parseTrustedOrigins('')]).toEqual([]);
		expect([...parseTrustedOrigins(null, null)]).toEqual([]);
		expect([...parseTrustedOrigins('  ,  , ')]).toEqual([]);
		expect([...parseTrustedOrigins('https://')]).toEqual([]);
		expect([...parseTrustedOrigins('https://a.example.com/path')]).toEqual([]);
		expect([...parseTrustedOrigins('https://a.example.com?q=1')]).toEqual([]);
		expect([...parseTrustedOrigins('https://a.example.com#x')]).toEqual([]);
		expect([...parseTrustedOrigins('https://user:pw@a.example.com')]).toEqual([]);
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
		expect(csrfOriginCheckDisabled('TRUE')).toBe(false);
	});
});

// The terminal WebSocket: a GET the browser sends with cookies from any page, so only the
// origin decides.
describe('isForbiddenCrossOriginUpgrade', () => {
	const ws = (over: Partial<Parameters<typeof isForbiddenCrossOriginUpgrade>[0]>) =>
		isForbiddenCrossOriginUpgrade({
			origin: 'http://192.168.1.50:3000',
			secFetchSite: null,
			host: '192.168.1.50:3000',
			trustedOrigins: new Set(),
			disabled: false,
			...over
		});

	test('the app own page opens a terminal', () => {
		expect(ws({})).toBe(false);
		expect(ws({ origin: 'https://dockhand.example.com', host: 'dockhand.example.com', secFetchSite: 'same-origin' })).toBe(false);
		expect(ws({ origin: 'http://localhost:5173', host: 'localhost:5173' })).toBe(false);
	});

	test('a page on another origin is refused', () => {
		expect(ws({ origin: 'https://evil.com' })).toBe(true);
		expect(ws({ origin: 'http://192.168.1.50:8080' })).toBe(true);
		expect(ws({ origin: 'https://evil.com', secFetchSite: 'cross-site' })).toBe(true);
	});

	test('a sibling origin on the same site is refused too', () => {
		expect(ws({ origin: 'https://wiki.example.com', host: 'dockhand.example.com', secFetchSite: 'same-site' })).toBe(true);
	});

	test('a trusted origin, a client without Origin, and the disabled check pass', () => {
		expect(ws({ origin: 'https://evil.com', trustedOrigins: new Set(['https://evil.com']) })).toBe(false);
		expect(ws({ origin: null })).toBe(false);
		expect(ws({ origin: 'https://evil.com', disabled: true })).toBe(false);
	});
});
