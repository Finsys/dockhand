/**
 * The registry auth handshake is cached: a batch of checks against one repository signs
 * in once per token lifetime instead of once per image and per call, which is what keeps
 * an update run under a registry's rate limit.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { authCacheKey, bearerTtlMs, createAuthCache, registryAuthCache } from '../src/lib/server/registry/auth-cache';
import {
	getRegistryBearerToken,
	getRegistryManifestDigestDirectDetailed,
	readManifestIndex,
	type RegistryPorts
} from '../src/lib/server/registry/manifest-digest';
import { registryAuthHeader } from '../src/lib/server/registry/auth-header';
import { fetchImageCreatedAt } from '../src/lib/server/registry/image-age';

beforeEach(() => registryAuthCache.clear());

describe('bearerTtlMs', () => {
	test('uses expires_in, less a safety margin', () => {
		expect(bearerTtlMs(300)).toBe(290_000);
	});

	test('a missing or invalid expires_in falls back to the spec default of 60s', () => {
		expect(bearerTtlMs(undefined)).toBe(50_000);
		expect(bearerTtlMs('300')).toBe(50_000);
		expect(bearerTtlMs(0)).toBe(50_000);
	});

	test('a token shorter than the margin is not reused at all', () => {
		expect(bearerTtlMs(5)).toBe(0);
	});
});

describe('authCacheKey', () => {
	test('different credentials, scopes or registries never share an entry', () => {
		const a = authCacheKey('https://ghcr.io', 'repository:t/a:pull', { username: 'u', password: 'p1' });
		expect(authCacheKey('https://ghcr.io', 'repository:t/a:pull', { username: 'u', password: 'p1' })).toBe(a);
		expect(authCacheKey('https://ghcr.io', 'repository:t/a:pull', { username: 'u', password: 'p2' })).not.toBe(a);
		expect(authCacheKey('https://ghcr.io', 'repository:t/a:pull', { username: 'v', password: 'p1' })).not.toBe(a);
		expect(authCacheKey('https://ghcr.io', 'repository:t/a:pull', null)).not.toBe(a);
		expect(authCacheKey('https://ghcr.io', 'repository:t/b:pull', { username: 'u', password: 'p1' })).not.toBe(a);
		expect(authCacheKey('http://ghcr.io', 'repository:t/a:pull', { username: 'u', password: 'p1' })).not.toBe(a);
	});

	test('the key does not carry the password', () => {
		expect(authCacheKey('https://ghcr.io', 's', { username: 'u', password: 'ghp_secret' })).not.toContain('ghp_secret');
	});
});

describe('createAuthCache', () => {
	test('reuses a stored header until it expires', async () => {
		let t = 0;
		const cache = createAuthCache(() => t);
		let calls = 0;
		const handshake = async () => ({ header: `Bearer ${++calls}`, ttlMs: 1000 });
		expect(await cache.get('k', handshake)).toBe('Bearer 1');
		t = 999;
		expect(await cache.get('k', handshake)).toBe('Bearer 1');
		t = 1000;
		expect(await cache.get('k', handshake)).toBe('Bearer 2');
	});

	test('an outcome with ttl 0 (a failure) is never stored', async () => {
		const cache = createAuthCache(() => 0);
		let calls = 0;
		const handshake = async () => ({ header: null, ttlMs: (++calls, 0) });
		await cache.get('k', handshake);
		await cache.get('k', handshake);
		expect(calls).toBe(2);
		expect(cache.size()).toBe(0);
	});

	test('concurrent lookups for one key share a single handshake', async () => {
		const cache = createAuthCache(() => 0);
		let calls = 0;
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const handshake = async () => {
			calls++;
			await gate;
			return { header: 'Bearer x', ttlMs: 1000 };
		};
		const all = Promise.all([cache.get('k', handshake), cache.get('k', handshake), cache.get('k', handshake)]);
		release();
		expect(await all).toEqual(['Bearer x', 'Bearer x', 'Bearer x']);
		expect(calls).toBe(1);
	});

	test('a handshake that throws is not stored and the next lookup tries again', async () => {
		const cache = createAuthCache(() => 0);
		let calls = 0;
		const handshake = async () => {
			if (++calls === 1) throw new Error('network');
			return { header: 'Bearer ok', ttlMs: 1000 };
		};
		await expect(cache.get('k', handshake)).rejects.toThrow('network');
		expect(await cache.get('k', handshake)).toBe('Bearer ok');
		expect(calls).toBe(2);
	});

	test('forget drops every entry holding a rejected header, and only those', async () => {
		const cache = createAuthCache(() => 0);
		await cache.get('a', async () => ({ header: 'Bearer old', ttlMs: 1000 }));
		await cache.get('b', async () => ({ header: 'Bearer old', ttlMs: 1000 }));
		await cache.get('c', async () => ({ header: 'Bearer other', ttlMs: 1000 }));
		cache.forget('Bearer old');
		expect(cache.size()).toBe(1);
		expect(await cache.get('c', async () => ({ header: 'Bearer new', ttlMs: 1000 }))).toBe('Bearer other');
	});
});

/** A bearer registry that counts challenges and token requests, and answers manifests. */
function fakeRegistry(opts: { manifestStatus?: () => number; expiresIn?: number } = {}) {
	const counts = { challenge: 0, token: 0, manifest: 0 };
	let tokenNo = 0;
	const fn = (async (url: string) => {
		const u = String(url);
		if (u.endsWith('/v2/')) {
			counts.challenge++;
			return new Response('', {
				status: 401,
				headers: { 'WWW-Authenticate': 'Bearer realm="https://auth.example.com/token",service="reg"' }
			});
		}
		if (u.includes('auth.example.com/token')) {
			counts.token++;
			return Response.json({ token: `t${++tokenNo}`, ...(opts.expiresIn ? { expires_in: opts.expiresIn } : {}) });
		}
		counts.manifest++;
		const status = opts.manifestStatus?.() ?? 200;
		return new Response(null, { status, headers: status === 200 ? { 'Docker-Content-Digest': 'sha256:abc' } : {} });
	}) as unknown as typeof fetch;
	return { fn, counts };
}

function ports(fn: typeof fetch, creds: { username: string; password: string } | null = null): RegistryPorts {
	return {
		parseRegistryUrl: (url: string) => ({ host: url.replace(/^https?:\/\//, ''), protocol: 'https' }),
		hubHosts: new Set(),
		listRegistries: async () => [],
		findCredentials: async () => creds,
		fetch: fn
	};
}

describe('update checks reuse the sign-in', () => {
	test('many checks of one repository sign in once', async () => {
		const { fn, counts } = fakeRegistry();
		for (let i = 0; i < 5; i++) {
			expect((await getRegistryManifestDigestDirectDetailed('reg.example.com/team/app:1', ports(fn))).digest).toBe('sha256:abc');
		}
		expect(counts).toEqual({ challenge: 1, token: 1, manifest: 5 });
	});

	test('a batch fired in parallel signs in once', async () => {
		const { fn, counts } = fakeRegistry();
		await Promise.all(Array.from({ length: 8 }, () => getRegistryManifestDigestDirectDetailed('reg.example.com/team/app:1', ports(fn))));
		expect(counts.token).toBe(1);
	});

	test('another repository, or other credentials, get their own token', async () => {
		const { fn, counts } = fakeRegistry();
		await getRegistryBearerToken('reg.example.com', 'team/app', ports(fn));
		await getRegistryBearerToken('reg.example.com', 'team/other', ports(fn));
		await getRegistryBearerToken('reg.example.com', 'team/app', ports(fn, { username: 'u', password: 'p' }));
		expect(counts.token).toBe(3);
	});

	test('a 401 on the manifest drops the token, so the next check signs in again', async () => {
		let status = 401;
		const { fn, counts } = fakeRegistry({ manifestStatus: () => status });
		await getRegistryManifestDigestDirectDetailed('reg.example.com/team/app:1', ports(fn));
		status = 200;
		const r = await getRegistryManifestDigestDirectDetailed('reg.example.com/team/app:1', ports(fn));
		expect(r.digest).toBe('sha256:abc');
		expect(counts.token).toBe(2);
	});

	test('a 401 on an index read drops the token it was sent with', async () => {
		await registryAuthCache.get('k', async () => ({ header: 'Bearer stale', ttlMs: 60_000 }));
		const fn = (async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
		await readManifestIndex('reg.example.com', 'team/app', 'sha256:abc', 'Bearer stale', 'https', fn);
		expect(registryAuthCache.size()).toBe(0);
	});

	test('a 429 on the manifest keeps the token', async () => {
		let status = 429;
		const { fn, counts } = fakeRegistry({ manifestStatus: () => status });
		await getRegistryManifestDigestDirectDetailed('reg.example.com/team/app:1', ports(fn));
		status = 200;
		await getRegistryManifestDigestDirectDetailed('reg.example.com/team/app:1', ports(fn));
		expect(counts.token).toBe(1);
	});

	test('a failed token request is not cached', async () => {
		let fail = true;
		const counts = { token: 0 };
		const fn = (async (url: string) => {
			if (String(url).endsWith('/v2/')) {
				return new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="https://auth.example.com/token"' } });
			}
			counts.token++;
			return fail ? new Response('denied', { status: 403 }) : Response.json({ token: 'ok' });
		}) as unknown as typeof fetch;
		expect(await getRegistryBearerToken('reg.example.com', 'team/app', ports(fn))).toBeNull();
		fail = false;
		expect(await getRegistryBearerToken('reg.example.com', 'team/app', ports(fn))).toBe('Bearer ok');
		expect(counts.token).toBe(2);
	});
});

describe('tag listing shares the cache, a login check bypasses it', () => {
	const parseRegistryUrl = (url: string) => {
		const m = url.match(/^(https?):\/\/([^/]+)/)!;
		return { host: m[2], protocol: m[1] };
	};

	test('a tag listing after a digest check of the same repo reuses its token', async () => {
		const { fn, counts } = fakeRegistry();
		await getRegistryBearerToken('reg.example.com', 'team/app', ports(fn));
		const header = await registryAuthHeader('https://reg.example.com', 'repository:team/app:pull', null, { parseRegistryUrl, fetch: fn });
		expect(header).toBe('Bearer t1');
		expect(counts.token).toBe(1);
	});

	test('an empty scope (Test connection) always asks the registry', async () => {
		const { fn, counts } = fakeRegistry();
		const creds = { username: 'u', password: 'p' };
		await registryAuthHeader('https://reg.example.com', '', creds, { parseRegistryUrl, fetch: fn });
		await registryAuthHeader('https://reg.example.com', '', creds, { parseRegistryUrl, fetch: fn });
		expect(counts.token).toBe(2);
		expect(registryAuthCache.size()).toBe(0);
	});
});

describe('a shared sign-in is not tied to one caller', () => {
	/** Challenge and token each take `delayMs` and honour their signal, like a real fetch. */
	function slowRegistry(delayMs: number) {
		const counts = { challenge: 0, token: 0 };
		const fn = (async (url: string, init?: any) => {
			const signal: AbortSignal | undefined = init?.signal;
			await new Promise<void>((resolve, reject) => {
				if (signal?.aborted) return reject(signal.reason);
				const t = setTimeout(resolve, delayMs);
				signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); });
			});
			if (String(url).endsWith('/v2/')) {
				counts.challenge++;
				return new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="https://auth.example.com/token"' } });
			}
			counts.token++;
			return Response.json({ token: 'T' });
		}) as unknown as typeof fetch;
		return { fn, counts };
	}

	test('the first caller giving up does not fail a caller that joined its sign-in', async () => {
		const { fn, counts } = slowRegistry(40);
		const leader = new AbortController();
		const first = getRegistryBearerToken('reg.example.com', 'team/app', ports(fn), leader.signal);
		await new Promise((r) => setTimeout(r, 5));
		const second = getRegistryBearerToken('reg.example.com', 'team/app', ports(fn));
		// Let the second caller reach the shared sign-in before the first one gives up.
		await new Promise((r) => setTimeout(r, 5));
		leader.abort();
		expect(await first).toBeNull();
		expect(await second).toBe('Bearer T');
		expect(counts.challenge).toBe(1);
	});

	test('the same holds for the tag-list sign-in', async () => {
		const { fn, counts } = slowRegistry(40);
		const parseRegistryUrl = (url: string) => ({ host: url.replace(/^https?:\/\//, ''), protocol: 'https' });
		const leader = new AbortController();
		const first = registryAuthHeader('https://reg.example.com', 'repository:a:pull', null, { parseRegistryUrl, fetch: fn, signal: leader.signal });
		await new Promise((r) => setTimeout(r, 5));
		const second = registryAuthHeader('https://reg.example.com', 'repository:a:pull', null, { parseRegistryUrl, fetch: fn });
		await new Promise((r) => setTimeout(r, 5));
		leader.abort();
		expect(await first).toBeNull();
		expect(await second).toBe('Bearer T');
		expect(counts.challenge).toBe(1);
	});

	test('a joining caller giving up returns at once and leaves the sign-in running for the others', async () => {
		const { fn } = slowRegistry(40);
		const first = getRegistryBearerToken('reg.example.com', 'team/app', ports(fn));
		const joiner = new AbortController();
		const second = getRegistryBearerToken('reg.example.com', 'team/app', ports(fn), joiner.signal);
		joiner.abort();
		expect(await second).toBeNull();
		expect(await first).toBe('Bearer T');
	});

	test('the sign-in is cancelled once every caller with a signal gave up, and a later caller starts afresh', async () => {
		const cache = createAuthCache(() => 0);
		let seen: AbortSignal | undefined;
		const hang = (signal: AbortSignal) => {
			seen = signal;
			return new Promise<{ header: string | null; ttlMs: number }>((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
		};
		const a = new AbortController();
		const b = new AbortController();
		const pa = cache.get('k', hang, a.signal);
		const pb = cache.get('k', hang, b.signal);
		a.abort();
		expect(seen!.aborted).toBe(false);
		b.abort();
		expect(seen!.aborted).toBe(true);
		await expect(pa).rejects.toBeDefined();
		await expect(pb).rejects.toBeDefined();
		expect(await cache.get('k', async () => ({ header: 'Bearer fresh', ttlMs: 1000 }))).toBe('Bearer fresh');
	});

	test('a cancelled sign-in is not stored, even if it still produced a header', async () => {
		const cache = createAuthCache(() => 0);
		const c = new AbortController();
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const p = cache.get('k', async () => {
			await gate;
			return { header: 'Bearer late', ttlMs: 1000 };
		}, c.signal);
		c.abort();
		release();
		await expect(p).rejects.toBeDefined();
		await new Promise((r) => setTimeout(r, 0));
		expect(cache.size()).toBe(0);
	});
});

describe('cache bounds and what a 401 drops', () => {
	test('the oldest entry is evicted past the limit', async () => {
		const cache = createAuthCache(() => 0, 2);
		for (const k of ['a', 'b', 'c']) await cache.get(k, async () => ({ header: `Bearer ${k}`, ttlMs: 1000 }));
		expect(cache.size()).toBe(2);
		let asked = false;
		await cache.get('a', async () => ((asked = true), { header: 'Bearer a2', ttlMs: 1000 }));
		expect(asked).toBe(true);
	});

	test('a 401 without a header drops the stored "no auth needed" answer for that host only', async () => {
		const cache = createAuthCache(() => 0);
		await cache.get('https://reg.example.com|repository:a:pull|anonymous', async () => ({ header: null, ttlMs: 1000 }));
		await cache.get('https://other.example.com|repository:a:pull|anonymous', async () => ({ header: null, ttlMs: 1000 }));
		await cache.get('https://reg.example.com|repository:b:pull|anonymous', async () => ({ header: 'Bearer keep', ttlMs: 1000 }));
		cache.forget(null, 'reg.example');
		expect(cache.size()).toBe(3);
		cache.forget(null, 'reg.example.com');
		expect(cache.size()).toBe(2);
	});

	test('a registry that stops allowing anonymous access is asked again after the 401', async () => {
		let open = true;
		const counts = { challenge: 0, token: 0 };
		const fn = (async (url: string) => {
			const u = String(url);
			if (u.endsWith('/v2/')) {
				counts.challenge++;
				return open
					? new Response('{}')
					: new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="https://auth.example.com/token"' } });
			}
			if (u.includes('auth.example.com')) return (counts.token++, Response.json({ token: 'T' }));
			return open ? new Response(null, { status: 401 }) : new Response(null, { status: 200, headers: { 'Docker-Content-Digest': 'sha256:abc' } });
		}) as unknown as typeof fetch;
		await getRegistryManifestDigestDirectDetailed('reg.example.com/team/app:1', ports(fn));
		open = false;
		const r = await getRegistryManifestDigestDirectDetailed('reg.example.com/team/app:1', ports(fn));
		expect(r.digest).toBe('sha256:abc');
		expect(counts.challenge).toBe(2);
	});
});

describe('Basic, anonymous and failed challenges', () => {
	function challengeOnly(respond: () => Response) {
		const counts = { challenge: 0 };
		const fn = (async (url: string) => {
			if (String(url).endsWith('/v2/')) return (counts.challenge++, respond());
			return new Response(null, { status: 200, headers: { 'Docker-Content-Digest': 'sha256:abc' } });
		}) as unknown as typeof fetch;
		return { fn, counts };
	}

	test('a Basic registry is challenged once for a batch', async () => {
		const { fn, counts } = challengeOnly(() => new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="r"' } }));
		const p = ports(fn, { username: 'u', password: 'p' });
		for (let i = 0; i < 3; i++) await getRegistryManifestDigestDirectDetailed('reg.example.com/team/app:1', p);
		expect(counts.challenge).toBe(1);
		expect(await getRegistryBearerToken('reg.example.com', 'team/app', p)).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
	});

	test('a registry that needs no auth is challenged once for a batch', async () => {
		const { fn, counts } = challengeOnly(() => new Response('{}'));
		for (let i = 0; i < 3; i++) await getRegistryManifestDigestDirectDetailed('reg.example.com/team/app:1', ports(fn));
		expect(counts.challenge).toBe(1);
	});

	test('a failed challenge (503) is not stored', async () => {
		let down = true;
		const { fn, counts } = challengeOnly(() =>
			down ? new Response('', { status: 503 }) : new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="r"' } })
		);
		const p = ports(fn, { username: 'u', password: 'p' });
		expect(await getRegistryBearerToken('reg.example.com', 'team/app', p)).toBeNull();
		down = false;
		expect(await getRegistryBearerToken('reg.example.com', 'team/app', p)).not.toBeNull();
		expect(counts.challenge).toBe(2);
	});

	test('a 404 on an index read keeps the token', async () => {
		await registryAuthCache.get('k', async () => ({ header: 'Bearer keep', ttlMs: 60_000 }));
		const fn = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
		await readManifestIndex('reg.example.com', 'team/app', 'sha256:abc', 'Bearer keep', 'https', fn);
		expect(registryAuthCache.size()).toBe(1);
	});

	test('a 401 on the image-age metadata drops the token it was sent with', async () => {
		await registryAuthCache.get('k', async () => ({ header: 'Bearer stale', ttlMs: 60_000 }));
		const fetcher = async () => new Response(null, { status: 401 });
		await fetchImageCreatedAt({
			registry: 'reg.example.com', repo: 'team/app', digest: 'sha256:' + 'a'.repeat(64),
			platform: { os: 'linux', architecture: 'amd64' }, scheme: 'https', authorization: 'Bearer stale'
		}, fetcher);
		expect(registryAuthCache.size()).toBe(0);
	});
});

describe('registryAuthHeader on its own', () => {
	const parseRegistryUrl = (url: string) => {
		const m = url.match(/^(https?):\/\/([^/]+)/)!;
		return { host: m[2], protocol: m[1] };
	};
	const creds = { username: 'u', password: 'p' };

	test('repeated lookups for one scope fetch one token; other credentials fetch their own', async () => {
		const { fn, counts } = fakeRegistry();
		const deps = { parseRegistryUrl, fetch: fn };
		expect(await registryAuthHeader('https://reg.example.com', 'repository:a:pull', creds, deps)).toBe('Bearer t1');
		expect(await registryAuthHeader('https://reg.example.com/org', 'repository:a:pull', creds, deps)).toBe('Bearer t1');
		expect(await registryAuthHeader('https://reg.example.com', 'repository:a:pull', { username: 'u', password: 'q' }, deps)).toBe('Bearer t2');
		expect(counts.token).toBe(2);
	});

	test('a failed token request and a failed challenge are not stored', async () => {
		let fail = true;
		const counts = { challenge: 0, token: 0 };
		const fn = (async (url: string) => {
			if (String(url).endsWith('/v2/')) {
				counts.challenge++;
				if (fail && counts.challenge === 1) return new Response('', { status: 503 });
				return new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="https://auth.example.com/token"' } });
			}
			counts.token++;
			return fail ? new Response('denied', { status: 403 }) : Response.json({ token: 'ok' });
		}) as unknown as typeof fetch;
		const deps = { parseRegistryUrl, fetch: fn };
		expect(await registryAuthHeader('https://reg.example.com', 'repository:a:pull', creds, deps)).toBeNull();
		expect(await registryAuthHeader('https://reg.example.com', 'repository:a:pull', creds, deps)).toBeNull();
		fail = false;
		expect(await registryAuthHeader('https://reg.example.com', 'repository:a:pull', creds, deps)).toBe('Bearer ok');
		expect(counts.challenge).toBe(3);
	});

	test('a Basic answer is stored', async () => {
		const counts = { challenge: 0 };
		const fn = (async () => (counts.challenge++, new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="r"' } }))) as unknown as typeof fetch;
		const deps = { parseRegistryUrl, fetch: fn };
		await registryAuthHeader('https://reg.example.com', 'repository:a:pull', creds, deps);
		await registryAuthHeader('https://reg.example.com', 'repository:a:pull', creds, deps);
		expect(counts.challenge).toBe(1);
	});

	test('cache: false always asks the registry and stores nothing', async () => {
		const { fn, counts } = fakeRegistry();
		const deps = { parseRegistryUrl, fetch: fn, cache: false };
		await registryAuthHeader('https://reg.example.com', 'repository:a:pull', creds, deps);
		await registryAuthHeader('https://reg.example.com', 'repository:a:pull', creds, deps);
		expect(counts.token).toBe(2);
		expect(registryAuthCache.size()).toBe(0);
	});
});
