import { describe, test, expect } from 'bun:test';
import { encodeRegistryAuth } from '../src/lib/server/registry-auth';

describe('encodeRegistryAuth', () => {
	test('produces base64url WITH = padding (Go URLEncoding compatible)', () => {
		// Docker daemon uses base64.URLEncoding.DecodeString which requires padding.
		// Unpadded base64url is silently treated as malformed → anonymous pull → rate limit.
		// Reference: moby/api/pkg/authconfig/authconfig.go
		// Fake 36-char value matching the shape of a Docker Hub PAT
		// (the test only cares about encoding shape, not validity).
		const header = encodeRegistryAuth({
			username: 'someuser',
			password: 'x'.repeat(36),
			serveraddress: 'https://index.docker.io/v1/'
		});

		// Length must be a multiple of 4 (padding requirement)
		expect(header.length % 4).toBe(0);

		// Must end in '=' for this particular payload (verified manually)
		expect(header.endsWith('=')).toBe(true);

		// Must use base64url alphabet (no '+' or '/')
		expect(header).not.toMatch(/[+/]/);
	});

	test('round-trips through Node Buffer base64url decode', () => {
		const input = { username: 'u', password: 'p', serveraddress: 'r' };
		const header = encodeRegistryAuth(input);
		// Node's base64url decode tolerates padding, so we can verify round-trip
		const decoded = JSON.parse(Buffer.from(header, 'base64url').toString());
		expect(decoded).toEqual(input);
	});

	test('empty payload encodes to "e30=" (base64url of "{}")', () => {
		const header = encodeRegistryAuth({});
		expect(header).toBe('e30=');
	});

	test('payload length divisible by 3 produces no padding', () => {
		// "abc" base64url-encodes to "YWJj" (4 chars, no padding needed)
		const header = encodeRegistryAuth({ x: 'a' }); // {"x":"a"} = 9 bytes
		// 9 bytes → 12 base64 chars exactly, no padding
		expect(header).toBe('eyJ4IjoiYSJ9');
		expect(header.length % 4).toBe(0);
	});
});

import { canReattachAuthOnRedirect } from '../src/lib/server/registry-auth';

describe('canReattachAuthOnRedirect', () => {
	test('same host, scheme change only -> re-attach (the Harbor http->https realm case, #1428)', () => {
		expect(canReattachAuthOnRedirect(
			'http://docker.example.com/service/token?service=harbor-registry',
			'https://docker.example.com/service/token?service=harbor-registry'
		)).toBe(true);
	});

	test('same host, different port -> re-attach', () => {
		expect(canReattachAuthOnRedirect('https://reg.example.com/token', 'https://reg.example.com:8443/token')).toBe(true);
	});

	test('different host -> refuse (never leak creds to another server)', () => {
		expect(canReattachAuthOnRedirect('https://reg.example.com/token', 'https://evil.example.com/token')).toBe(false);
	});

	test('different subdomain counts as a different host -> refuse', () => {
		expect(canReattachAuthOnRedirect('https://a.example.com/token', 'https://b.example.com/token')).toBe(false);
	});

	test('malformed URL -> refuse (fail closed)', () => {
		expect(canReattachAuthOnRedirect('not a url', 'https://reg.example.com/token')).toBe(false);
	});
});

import { fetchRegistryToken, type FetchLike } from '../src/lib/server/registry-auth';

// A tiny fake Response for the loop tests.
function fakeRes(status: number, location?: string, body = '') {
	return {
		status,
		headers: { get: (k: string) => (k.toLowerCase() === 'location' ? location ?? null : null) },
		body: null,
		text: async () => body,
	} as unknown as Response;
}

describe('fetchRegistryToken redirect follow', () => {
	test('no redirect: returns the first response, auth sent once', async () => {
		const seen: Array<{ url: string; auth?: string }> = [];
		const fake: FetchLike = async (url, init) => {
			seen.push({ url, auth: init?.headers?.['Authorization'] });
			return fakeRes(200, undefined, '{"token":"ok"}');
		};
		const res = await fetchRegistryToken('https://reg.example.com/token', 'Basic abc', fake);
		expect(res.status).toBe(200);
		expect(seen.length).toBe(1);
		expect(seen[0].auth).toBe('Basic abc');
	});

	test('same-host http->https redirect: follows and re-attaches auth (#1428)', async () => {
		const seen: Array<{ url: string; auth?: string }> = [];
		const fake: FetchLike = async (url, init) => {
			seen.push({ url, auth: init?.headers?.['Authorization'] });
			if (url.startsWith('http://')) return fakeRes(301, 'https://reg.example.com/token?x=1');
			return fakeRes(200, undefined, '{"token":"ok"}');
		};
		const res = await fetchRegistryToken('http://reg.example.com/token?x=1', 'Basic abc', fake);
		expect(res.status).toBe(200);
		expect(seen.length).toBe(2);
		expect(seen[0].auth).toBe('Basic abc'); // sent on the http realm
		expect(seen[1].auth).toBe('Basic abc'); // re-attached after the same-host 301
	});

	test('cross-host redirect: follows but DROPS auth (no credential leak)', async () => {
		const seen: Array<{ url: string; auth?: string }> = [];
		const fake: FetchLike = async (url, init) => {
			seen.push({ url, auth: init?.headers?.['Authorization'] });
			if (url.includes('reg.example.com')) return fakeRes(302, 'https://evil.example.com/token');
			return fakeRes(200, undefined, '{"token":"anon"}');
		};
		const res = await fetchRegistryToken('https://reg.example.com/token', 'Basic secret', fake);
		expect(res.status).toBe(200);
		expect(seen[0].auth).toBe('Basic secret');
		expect(seen[1].auth).toBeUndefined(); // stripped crossing to evil.example.com
	});

	test('redirect loop is bounded (does not hang)', async () => {
		let calls = 0;
		const fake: FetchLike = async (url) => { calls++; return fakeRes(301, 'https://reg.example.com/again'); };
		await fetchRegistryToken('https://reg.example.com/token', null, fake);
		expect(calls).toBeLessThanOrEqual(5); // 4 hops + 1 final
	});

	test('a blocked initial realm host throws before any fetch', async () => {
		let calls = 0;
		const fake: FetchLike = async () => { calls++; return fakeRes(200, undefined, '{"token":"x"}'); };
		await expect(fetchRegistryToken('http://169.254.169.254/token', null, fake)).rejects.toThrow();
		expect(calls).toBe(0);
	});

	test('a redirect to a blocked host throws instead of following it', async () => {
		let calls = 0;
		const fake: FetchLike = async () => { calls++; return fakeRes(302, 'http://127.0.0.1/token'); };
		await expect(fetchRegistryToken('https://reg.example.com/token', null, fake)).rejects.toThrow();
		expect(calls).toBe(1); // fetched the public host once, refused the private redirect
	});

	test('a public realm (Docker Hub) is allowed', async () => {
		const fake: FetchLike = async () => fakeRes(200, undefined, '{"token":"x"}');
		const res = await fetchRegistryToken('https://auth.docker.io/token?service=registry.docker.io', 'Basic x', fake);
		expect(res.status).toBe(200);
	});
});

import { isSafeRegistryHost } from '../src/lib/server/registry-auth';

describe('isSafeRegistryHost', () => {
	// Image-derived registry hosts: block the dangerous set, allow public + LAN.
	test('blocks loopback, cloud metadata and reserved', () => {
		for (const h of ['127.0.0.1', '127.0.0.1:5000', 'localhost', '169.254.169.254', '169.254.169.254:80', '0.0.0.0', '[::1]']) {
			expect(isSafeRegistryHost(h).ok).toBe(false);
		}
	});

	test('allows public registries and LAN self-hosted registries', () => {
		for (const h of ['ghcr.io', 'registry-1.docker.io', 'registry.example.com', '192.168.1.50:5000', '10.0.0.5:5000', '172.16.4.4']) {
			expect(isSafeRegistryHost(h).ok).toBe(true);
		}
	});
});
