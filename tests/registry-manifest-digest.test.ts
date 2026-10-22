/**
 * The registry HTTP conversation: scheme resolution, the v2 auth challenge, and
 * the manifest digest behind a tag.
 *
 * These ran inside docker.ts and could only be exercised against a live registry.
 * Pulled out behind injected ports, they answer here with a fake fetch, so the
 * failure modes that matter - a plain-HTTP registry, a 401 challenge, a rate
 * limit, a redirect on the challenge - are pinned rather than hoped for.
 */

import { describe, expect, test } from 'bun:test';
import {
	getRegistryBearerToken,
	getRegistryManifestDigestDirectDetailed,
	getRegistrySchemeForHost,
	type RegistryPorts
} from '../src/lib/server/registry/manifest-digest';

const HUB = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);

interface Call {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	redirect?: string;
}

/** A fetch that answers from a url->Response table and records what was asked. */
function fakeFetch(routes: Record<string, () => Response>) {
	const calls: Call[] = [];
	const fn = (async (url: string, init?: any) => {
		calls.push({ url: String(url), method: init?.method, headers: init?.headers, redirect: init?.redirect });
		for (const [pattern, make] of Object.entries(routes)) {
			// CHALLENGE is the bare /v2/ probe; it must not also match a manifest URL,
			// which has the repository path after /v2/.
			const hit = pattern === 'CHALLENGE' ? String(url).endsWith('/v2/') : String(url).includes(pattern);
			if (hit) return make();
		}
		return new Response('not found', { status: 404 });
	}) as unknown as typeof fetch;
	return { fn, calls };
}

function ports(over: Partial<RegistryPorts> = {}): RegistryPorts {
	return {
		parseRegistryUrl: (url: string) => {
			const m = url.match(/^(https?):\/\/([^/]+)/);
			return m ? { host: m[2], protocol: m[1] } : { host: url, protocol: 'https' };
		},
		hubHosts: HUB,
		listRegistries: async () => [],
		findCredentials: async () => null,
		...over
	};
}

describe('scheme resolution honours how a registry was configured', () => {
	test('an unconfigured host defaults to https', async () => {
		expect(await getRegistrySchemeForHost('ghcr.io', ports())).toBe('https');
	});

	test('a registry stored as plain http is fetched over http', async () => {
		const p = ports({ listRegistries: async () => [{ url: 'http://registry.local:5000' }] });
		expect(await getRegistrySchemeForHost('registry.local:5000', p)).toBe('http');
	});

	test('a registry stored as https stays https', async () => {
		const p = ports({ listRegistries: async () => [{ url: 'https://registry.local:5000' }] });
		expect(await getRegistrySchemeForHost('registry.local:5000', p)).toBe('https');
	});

	test('the right registry is matched when several are stored', async () => {
		const p = ports({
			listRegistries: async () => [
				{ url: 'https://ghcr.io' },
				{ url: 'http://registry.local:5000' },
				{ url: 'https://quay.io' }
			]
		});
		expect(await getRegistrySchemeForHost('registry.local:5000', p)).toBe('http');
		expect(await getRegistrySchemeForHost('quay.io', p)).toBe('https');
		// a host that matches none of them still defaults to https
		expect(await getRegistrySchemeForHost('other.example.com', p)).toBe('https');
	});

	test('a failure reading the registry list falls back to https rather than throwing', async () => {
		const p = ports({ listRegistries: async () => { throw new Error('db down'); } });
		expect(await getRegistrySchemeForHost('registry.local:5000', p)).toBe('https');
	});
});

describe('the v2 auth challenge', () => {
	test('a registry that needs no auth yields no token', async () => {
		const { fn } = fakeFetch({ CHALLENGE: () => new Response('', { status: 200 }) });
		expect(await getRegistryBearerToken('reg.example.com', 'app', ports({ fetch: fn }))).toBeNull();
	});

	test('a bearer challenge is exchanged for a token', async () => {
		const { fn, calls } = fakeFetch({
			CHALLENGE: () => new Response('', {
				status: 401,
				headers: { 'WWW-Authenticate': 'Bearer realm="https://auth.example.com/token",service="reg"' }
			}),
			'auth.example.com/token': () => Response.json({ token: 'abc123' })
		});
		expect(await getRegistryBearerToken('reg.example.com', 'team/app', ports({ fetch: fn })))
			.toBe('Bearer abc123');
		// the requested scope must name the repository being pulled
		const tokenCall = calls.find((c) => c.url.includes('auth.example.com'))!;
		expect(tokenCall.url).toContain('scope=repository%3Ateam%2Fapp%3Apull');
		expect(tokenCall.url).toContain('service=reg');
	});

	test('access_token is accepted as well as token', async () => {
		const { fn } = fakeFetch({
			CHALLENGE: () => new Response('', {
				status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="https://auth.example.com/token"' }
			}),
			'auth.example.com/token': () => Response.json({ access_token: 'xyz' })
		});
		expect(await getRegistryBearerToken('reg.example.com', 'app', ports({ fetch: fn }))).toBe('Bearer xyz');
	});

	test('a basic challenge uses stored credentials', async () => {
		const { fn } = fakeFetch({
			CHALLENGE: () => new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="reg"' } })
		});
		const p = ports({ fetch: fn, findCredentials: async () => ({ username: 'u', password: 'p' }) });
		expect(await getRegistryBearerToken('reg.example.com', 'app', p))
			.toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
	});

	test('a basic challenge without credentials yields no token', async () => {
		const { fn } = fakeFetch({
			CHALLENGE: () => new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="reg"' } })
		});
		expect(await getRegistryBearerToken('reg.example.com', 'app', ports({ fetch: fn }))).toBeNull();
	});

	test('the challenge request does not follow redirects', async () => {
		const { fn, calls } = fakeFetch({ CHALLENGE: () => new Response('', { status: 307 }) });
		expect(await getRegistryBearerToken('reg.example.com', 'app', ports({ fetch: fn }))).toBeNull();
		expect(calls[0].redirect).toBe('manual');
	});

	test('an unsupported auth scheme yields no token', async () => {
		const { fn } = fakeFetch({
			CHALLENGE: () => new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Negotiate' } })
		});
		expect(await getRegistryBearerToken('reg.example.com', 'app', ports({ fetch: fn }))).toBeNull();
	});

	test('a bearer challenge with no realm yields no token', async () => {
		const { fn } = fakeFetch({
			CHALLENGE: () => new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Bearer service="reg"' } })
		});
		expect(await getRegistryBearerToken('reg.example.com', 'app', ports({ fetch: fn }))).toBeNull();
	});

	test('a failed token request yields no token rather than throwing', async () => {
		const { fn } = fakeFetch({
			CHALLENGE: () => new Response('', {
				status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="https://auth.example.com/token"' }
			}),
			'auth.example.com/token': () => new Response('denied', { status: 403 })
		});
		expect(await getRegistryBearerToken('reg.example.com', 'app', ports({ fetch: fn }))).toBeNull();
	});

	test('a blocked host is refused before any request is made', async () => {
		const { fn, calls } = fakeFetch({ CHALLENGE: () => new Response('', { status: 200 }) });
		expect(await getRegistryBearerToken('127.0.0.1:5000', 'app', ports({ fetch: fn }))).toBeNull();
		expect(calls).toHaveLength(0);
	});

	test('a plain-http registry gets an http challenge, not https', async () => {
		const { fn, calls } = fakeFetch({ CHALLENGE: () => new Response('', { status: 200 }) });
		const p = ports({ fetch: fn, listRegistries: async () => [{ url: 'http://registry.local:5000' }] });
		await getRegistryBearerToken('registry.local:5000', 'app', p);
		expect(calls[0].url).toBe('http://registry.local:5000/v2/');
	});
});

describe('the manifest digest behind a tag', () => {
	const digestHeaders = { 'Docker-Content-Digest': 'sha256:' + 'a'.repeat(64) };

	test('the digest comes back from the HEAD response', async () => {
		const { fn, calls } = fakeFetch({
			CHALLENGE: () => new Response('', { status: 200 }),
			'/manifests/': () => new Response('', { status: 200, headers: digestHeaders })
		});
		const r = await getRegistryManifestDigestDirectDetailed('ghcr.io/team/app:1.2', ports({ fetch: fn }));
		expect(r.digest).toBe('sha256:' + 'a'.repeat(64));
		expect(r.reason).toBeUndefined();
		const head = calls.find((c) => c.url.includes('/manifests/'))!;
		expect(head.method).toBe('HEAD');
		expect(head.url).toBe('https://ghcr.io/v2/team/app/manifests/1.2');
	});

	test('a digest reference is addressed by its digest, not a tag', async () => {
		const ref = 'ghcr.io/team/app@sha256:' + 'b'.repeat(64);
		const { fn, calls } = fakeFetch({
			CHALLENGE: () => new Response('', { status: 200 }),
			'/manifests/': () => new Response('', { status: 200, headers: digestHeaders })
		});
		await getRegistryManifestDigestDirectDetailed(ref, ports({ fetch: fn }));
		expect(calls.find((c) => c.url.includes('/manifests/'))!.url).toContain('/manifests/sha256:' + 'b'.repeat(64));
	});

	test('it asks for both docker and oci manifest types', async () => {
		const { fn, calls } = fakeFetch({
			CHALLENGE: () => new Response('', { status: 200 }),
			'/manifests/': () => new Response('', { status: 200, headers: digestHeaders })
		});
		await getRegistryManifestDigestDirectDetailed('ghcr.io/team/app:1', ports({ fetch: fn }));
		const accept = calls.find((c) => c.url.includes('/manifests/'))!.headers!['Accept'];
		expect(accept).toContain('application/vnd.oci.image.index.v1+json');
		expect(accept).toContain('application/vnd.docker.distribution.manifest.list.v2+json');
	});

	test('a token from the challenge is sent on the manifest request', async () => {
		const { fn, calls } = fakeFetch({
			CHALLENGE: () => new Response('', {
				status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="https://auth.example.com/token"' }
			}),
			'auth.example.com/token': () => Response.json({ token: 'tok' }),
			'/manifests/': () => new Response('', { status: 200, headers: digestHeaders })
		});
		const r = await getRegistryManifestDigestDirectDetailed('ghcr.io/team/app:1', ports({ fetch: fn }));
		// assert the digest too: without it the test passes on the 401 path, where the
		// header is set but the request never succeeds
		expect(r.digest).toBe('sha256:' + 'a'.repeat(64));
		expect(calls.find((c) => c.url.includes('/manifests/'))!.headers!['Authorization']).toBe('Bearer tok');
	});

	test('a blocked host is reported, not fetched', async () => {
		const { fn, calls } = fakeFetch({});
		const r = await getRegistryManifestDigestDirectDetailed('127.0.0.1:5000/app:1', ports({ fetch: fn }));
		expect(r.digest).toBeNull();
		expect(r.reason).toBeTruthy();
		expect(calls).toHaveLength(0);
	});

	test('a rate limit is reported as a reason rather than thrown', async () => {
		const { fn } = fakeFetch({
			CHALLENGE: () => new Response('', { status: 200 }),
			'/manifests/': () => new Response('', { status: 429, headers: { 'Retry-After': '60' } })
		});
		const r = await getRegistryManifestDigestDirectDetailed('ghcr.io/team/app:1', ports({ fetch: fn }));
		expect(r.digest).toBeNull();
		expect(r.reason).toBeTruthy();
	});

	test('a 200 with no digest header is a reason, not a silent null', async () => {
		const { fn } = fakeFetch({
			CHALLENGE: () => new Response('', { status: 200 }),
			'/manifests/': () => new Response('', { status: 200 })
		});
		const r = await getRegistryManifestDigestDirectDetailed('ghcr.io/team/app:1', ports({ fetch: fn }));
		expect(r.digest).toBeNull();
		expect(r.reason).toBeTruthy();
	});

	test('a network failure is reported rather than thrown', async () => {
		const fn = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
		const r = await getRegistryManifestDigestDirectDetailed('ghcr.io/team/app:1', ports({ fetch: fn }));
		expect(r.digest).toBeNull();
		expect(r.reason).toBeTruthy();
	});

	test('the abort signal reaches every request, so a cancelled check stops', async () => {
		const seen: (AbortSignal | undefined)[] = [];
		const signal = AbortSignal.timeout(60_000);
		const fn = (async (url: string, init?: any) => {
			seen.push(init?.signal);
			if (String(url).endsWith('/v2/')) {
				return new Response('', {
					status: 401,
					headers: { 'WWW-Authenticate': 'Bearer realm="https://auth.example.com/token"' }
				});
			}
			if (String(url).includes('auth.example.com')) return Response.json({ token: 'tok' });
			return new Response('', { status: 200, headers: digestHeaders });
		}) as unknown as typeof fetch;

		await getRegistryManifestDigestDirectDetailed('ghcr.io/team/app:1', ports({ fetch: fn }), signal);
		// challenge, token and manifest requests: all three must carry it
		expect(seen).toHaveLength(3);
		for (const s of seen) expect(s).toBe(signal);
	});

	test('a plain-http registry is read over http', async () => {
		const { fn, calls } = fakeFetch({
			CHALLENGE: () => new Response('', { status: 200 }),
			'/manifests/': () => new Response('', { status: 200, headers: digestHeaders })
		});
		const p = ports({ fetch: fn, listRegistries: async () => [{ url: 'http://registry.local:5000' }] });
		await getRegistryManifestDigestDirectDetailed('registry.local:5000/app:1', p);
		expect(calls.find((c) => c.url.includes('/manifests/'))!.url).toStartWith('http://registry.local:5000/');
	});
});
