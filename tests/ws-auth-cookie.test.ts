import { describe, expect, it } from 'bun:test';
import { parseCookieHeader, safeDecode } from '../src/lib/utils/cookie-parse';

describe('parseCookieHeader resilience (#1224)', () => {
	it('decodes well-formed percent-encoded values', () => {
		const out = parseCookieHeader('foo=hello%20world; bar=a%2Bb');
		expect(out.foo).toBe('hello world');
		expect(out.bar).toBe('a+b');
	});

	it('does not throw on a malformed value — falls back to raw', () => {
		// `%E0%A4%A` is truncated; decodeURIComponent throws URIError on it.
		// Real-world reproducer: stray `%` from a third-party tracker cookie
		// that hitchhiked into the WS upgrade and crashed terminal exec.
		const out = parseCookieHeader('session=valid-token; bad=%E0%A4%A');
		expect(out.session).toBe('valid-token');
		expect(out.bad).toBe('%E0%A4%A');
	});

	it('does not throw on a bare lonely percent', () => {
		const out = parseCookieHeader('session=valid; weird=100%');
		expect(out.session).toBe('valid');
		expect(out.weird).toBe('100%');
	});

	it('strips surrounding double quotes', () => {
		const out = parseCookieHeader('foo="quoted-value"');
		expect(out.foo).toBe('quoted-value');
	});

	it('returns empty object for undefined or empty header', () => {
		expect(parseCookieHeader(undefined)).toEqual({});
		expect(parseCookieHeader('')).toEqual({});
	});

	it('safeDecode returns input on URIError', () => {
		expect(safeDecode('%E0%A4%A')).toBe('%E0%A4%A');
		expect(safeDecode('hello%20world')).toBe('hello world');
	});
});
