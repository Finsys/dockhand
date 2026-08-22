/**
 * ntfy ?auth= query parameter resolution (#1209).
 *
 * Run with: bun test tests/unit/ntfy-auth.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { resolveQueryAuth, resolveNtfyEndpoint } from '../src/lib/server/notifications/ntfy';

describe('ntfy resolveQueryAuth', () => {
	test('raw tk_ token becomes Bearer header', () => {
		expect(resolveQueryAuth('tk_fz03gou2w6vclsqnw5jt7mq9999jm')).toBe(
			'Bearer tk_fz03gou2w6vclsqnw5jt7mq9999jm'
		);
	});

	test('base64-encoded "Bearer <token>" is decoded', () => {
		const encoded = Buffer.from('Bearer abc123').toString('base64');
		expect(resolveQueryAuth(encoded)).toBe('Bearer abc123');
	});

	test('base64-encoded "Basic <creds>" is decoded', () => {
		const encoded = Buffer.from('Basic dXNlcjpwYXNz').toString('base64');
		expect(resolveQueryAuth(encoded)).toBe('Basic dXNlcjpwYXNz');
	});

	test('non-base64 raw token (no tk_ prefix) is treated as Bearer', () => {
		expect(resolveQueryAuth('myrawtoken')).toBe('Bearer myrawtoken');
	});

	test('base64 input that decodes to non-Bearer/Basic falls back to raw', () => {
		const encoded = Buffer.from('something else').toString('base64');
		expect(resolveQueryAuth(encoded)).toBe(`Bearer ${encoded}`);
	});

	test('header value is always ASCII-safe (regression: U+FFFD)', () => {
		// The original bug: raw tk_ tokens were decoded as base64, producing
		// 0xFFFD chars that fetch() rejected as ByteString-incompatible.
		const result = resolveQueryAuth('tk_fz03gou2w6vclsqnw5jt7mq9999jm');
		for (let i = 0; i < result.length; i++) {
			expect(result.charCodeAt(i)).toBeLessThanOrEqual(0xff);
		}
	});
});

describe('ntfy resolveNtfyEndpoint', () => {
	// THE BUG (#1300): a trailing slash on the topic made ntfy 404 (POST /topic/ is a
	// different route from POST /topic → {"code":40401,"http":404,...}). Confirmed
	// against a live ntfy server: POST /testtopic = 200, POST /testtopic/ = 404.
	test('strips a trailing slash from the topic (the #1300 404 bug)', () => {
		expect(resolveNtfyEndpoint('host.de/dockhand/', true).url).toBe('https://host.de/dockhand');
	});

	test('strips multiple trailing slashes', () => {
		expect(resolveNtfyEndpoint('host.de/dockhand//', false).url).toBe('http://host.de/dockhand');
	});

	test('no trailing slash is unchanged', () => {
		expect(resolveNtfyEndpoint('host.de/dockhand', true).url).toBe('https://host.de/dockhand');
	});

	test('public ntfy.sh single topic', () => {
		expect(resolveNtfyEndpoint('my-topic', false).url).toBe('https://ntfy.sh/my-topic');
	});

	test('public ntfy.sh topic with trailing slash is normalised', () => {
		expect(resolveNtfyEndpoint('my-topic/', false).url).toBe('https://ntfy.sh/my-topic');
	});

	test('secure host/topic', () => {
		expect(resolveNtfyEndpoint('host.de/topic', true).url).toBe('https://host.de/topic');
	});

	test('basic auth user:pass@host/topic with trailing slash', () => {
		const r = resolveNtfyEndpoint('user:pass@host.de/topic/', false);
		expect(r.url).toBe('http://host.de/topic');
		expect(r.authHeader).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`);
	});

	test('bearer token@host/topic with trailing slash', () => {
		const r = resolveNtfyEndpoint('tk_abc@host.de/topic/', true);
		expect(r.url).toBe('https://host.de/topic');
		expect(r.authHeader).toBe('Bearer tk_abc');
	});

	test('nested topic path keeps inner slashes, strips only trailing', () => {
		expect(resolveNtfyEndpoint('host.de/a/b/c/', true).url).toBe('https://host.de/a/b/c');
	});
});
