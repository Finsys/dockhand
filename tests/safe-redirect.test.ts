import { describe, test, expect } from 'bun:test';
import { isSafeRedirect, safeRedirectOrRoot } from '../src/lib/utils/safe-redirect';

describe('isSafeRedirect — accepts path-relative targets', () => {
	test('/', () => expect(isSafeRedirect('/')).toBe(true));
	test('/dashboard', () => expect(isSafeRedirect('/dashboard')).toBe(true));
	test('/path/with/segments', () => expect(isSafeRedirect('/path/with/segments')).toBe(true));
	test('/with?query=1', () => expect(isSafeRedirect('/with?query=1')).toBe(true));
	test('/with#hash', () => expect(isSafeRedirect('/with#hash')).toBe(true));
});

describe('isSafeRedirect — rejects cross-origin and weird forms', () => {
	test('absolute http URL', () =>
		expect(isSafeRedirect('http://evil.com/phish')).toBe(false));
	test('absolute https URL', () =>
		expect(isSafeRedirect('https://evil.com/phish')).toBe(false));
	test('protocol-relative //example.com', () =>
		expect(isSafeRedirect('//evil.com/phish')).toBe(false));
	test('backslash-prefixed /\\example.com (browser-normalization edge)', () =>
		expect(isSafeRedirect('/\\evil.com')).toBe(false));
	test('javascript: URL', () =>
		expect(isSafeRedirect('javascript:alert(1)')).toBe(false));
	test('data: URL', () =>
		expect(isSafeRedirect('data:text/html,<script>alert(1)</script>')).toBe(false));
	test('relative path without leading slash', () =>
		expect(isSafeRedirect('dashboard')).toBe(false));
	test('empty string', () => expect(isSafeRedirect('')).toBe(false));
	test('whitespace-only', () => expect(isSafeRedirect('   ')).toBe(false));
});

describe('isSafeRedirect — rejects non-string inputs', () => {
	test('null', () => expect(isSafeRedirect(null)).toBe(false));
	test('undefined', () => expect(isSafeRedirect(undefined)).toBe(false));
	test('number', () => expect(isSafeRedirect(42)).toBe(false));
	test('object', () => expect(isSafeRedirect({ url: '/x' })).toBe(false));
	test('array', () => expect(isSafeRedirect(['/x'])).toBe(false));
	test('boolean', () => expect(isSafeRedirect(true)).toBe(false));
});

describe('safeRedirectOrRoot — falls back to / on unsafe input', () => {
	test('safe → returned as-is', () =>
		expect(safeRedirectOrRoot('/dashboard')).toBe('/dashboard'));
	test('absolute URL → /', () =>
		expect(safeRedirectOrRoot('https://evil.com')).toBe('/'));
	test('protocol-relative → /', () =>
		expect(safeRedirectOrRoot('//evil.com')).toBe('/'));
	test('null → /', () => expect(safeRedirectOrRoot(null)).toBe('/'));
	test('undefined → /', () => expect(safeRedirectOrRoot(undefined)).toBe('/'));
	test('empty string → /', () => expect(safeRedirectOrRoot('')).toBe('/'));
	test('non-string → /', () =>
		expect(safeRedirectOrRoot({ x: 1 })).toBe('/'));
});
