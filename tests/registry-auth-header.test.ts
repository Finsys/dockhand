/**
 * The Registry V2 auth handshake (challenge, then token), driven by a fake fetch:
 * the header it produces, and that a registry which never answers either request
 * is cut off by the caller's deadline.
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import { registryAuthHeader } from '../src/lib/server/registry/auth-header';
import { registryAuthCache } from '../src/lib/server/registry/auth-cache';

// The auth handshake is cached process-wide; each test starts from an empty cache.
beforeEach(() => registryAuthCache.clear());

const parseRegistryUrl = (url: string) => {
	const m = url.match(/^(https?):\/\/([^/]+)/);
	return m ? { host: m[2], protocol: m[1] } : { host: url, protocol: 'https' };
};
const BEARER = { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="https://auth.example.com/token",service="registry.example.com"' } };
const hang = (init?: any) =>
	new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal.reason)));

describe('registryAuthHeader', () => {
	test('a registry that needs no auth gives no header', async () => {
		const fetch = (async () => new Response('{}')) as unknown as typeof globalThis.fetch;
		expect(await registryAuthHeader('https://registry.example.com', 'repository:a/b:pull', null, { parseRegistryUrl, fetch })).toBe(null);
	});

	test('a bearer challenge is answered with a token fetched with the credentials', async () => {
		let tokenAuth: string | undefined;
		const fetch = (async (url: string, init?: any) => {
			if (String(url).endsWith('/v2/')) return new Response('', BEARER);
			tokenAuth = init?.headers?.Authorization;
			expect(String(url)).toContain('scope=repository%3Aa%2Fb%3Apull');
			expect(String(url)).toContain('service=registry.example.com');
			return Response.json({ token: 'tok' });
		}) as unknown as typeof globalThis.fetch;
		const header = await registryAuthHeader('https://registry.example.com', 'repository:a/b:pull', { username: 'u', password: 'p' }, { parseRegistryUrl, fetch });
		expect(header).toBe('Bearer tok');
		expect(tokenAuth).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
	});

	test('a token server that answers with access_token is accepted', async () => {
		const fetch = (async (url: string) =>
			String(url).endsWith('/v2/') ? new Response('', BEARER) : Response.json({ access_token: 'tok' })) as unknown as typeof globalThis.fetch;
		expect(await registryAuthHeader('https://registry.example.com', '', null, { parseRegistryUrl, fetch })).toBe('Bearer tok');
	});

	test('the challenge is not followed off the guarded host', async () => {
		const seen: string[] = [];
		const fetch = (async (url: string, init?: any) => {
			seen.push(`${url} ${init?.redirect}`);
			return new Response('', { status: 302, headers: { Location: 'http://169.254.169.254/' } });
		}) as unknown as typeof globalThis.fetch;
		expect(await registryAuthHeader('https://registry.example.com', '', null, { parseRegistryUrl, fetch })).toBe(null);
		expect(seen).toEqual(['https://registry.example.com/v2/ manual']);
	});

	test('a basic challenge without credentials gives no header', async () => {
		const fetch = (async () => new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="r"' } })) as unknown as typeof globalThis.fetch;
		expect(await registryAuthHeader('https://registry.example.com', '', null, { parseRegistryUrl, fetch })).toBe(null);
	});

	test('a basic challenge uses the credentials directly', async () => {
		const fetch = (async () => new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="r"' } })) as unknown as typeof globalThis.fetch;
		expect(await registryAuthHeader('https://registry.example.com', '', { username: 'u', password: 'p' }, { parseRegistryUrl, fetch }))
			.toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
	});

	test('a blocked host is refused without a request', async () => {
		let calls = 0;
		const fetch = (async () => { calls++; return new Response('{}'); }) as unknown as typeof globalThis.fetch;
		expect(await registryAuthHeader('https://169.254.169.254', '', null, { parseRegistryUrl, fetch })).toBe(null);
		expect(calls).toBe(0);
	});

	test('a challenge that never answers is cut off by the deadline', async () => {
		const fetch = (async (_url: string, init?: any) => hang(init)) as unknown as typeof globalThis.fetch;
		const started = Date.now();
		expect(await registryAuthHeader('https://registry.example.com', '', null, { parseRegistryUrl, fetch, signal: AbortSignal.timeout(30) })).toBe(null);
		expect(Date.now() - started).toBeLessThan(2000);
	});

	test('a token endpoint that never answers is cut off by the deadline', async () => {
		const fetch = (async (url: string, init?: any) =>
			String(url).endsWith('/v2/') ? new Response('', BEARER) : hang(init)) as unknown as typeof globalThis.fetch;
		const started = Date.now();
		expect(await registryAuthHeader('https://registry.example.com', '', null, { parseRegistryUrl, fetch, signal: AbortSignal.timeout(30) })).toBe(null);
		expect(Date.now() - started).toBeLessThan(2000);
	});
});
