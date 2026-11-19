/**
 * Generic Registry v2 tag listing: the Link-header pagination that keeps newer
 * version tags from being lost behind a first page of git-hash tags.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

// The strategy resolves auth through docker.ts's getRegistryAuthHeader; stub it so
// the test never touches the network or the native docker module.
const credentialLookups: string[][] = [];
mock.module('../src/lib/server/docker', () => ({
	getRegistryAuthHeader: async () => 'Bearer test-token',
	findRegistryCredentials: async (host: string, repo: string) => {
		credentialLookups.push([host, repo]);
		return null;
	}
}));

const { fetchGenericV2Tags, fetchGenericV2TagsAfter } = await import('../src/lib/server/semver/strategies/generic-v2');
const { tagListings, createTagCache } = await import('../src/lib/server/semver/tag-source-core');
const { listVersionTags, __resetTagSourceCacheForTests } = await import('../src/lib/server/semver/tag-source');
const { registryAuthCache } = await import('../src/lib/server/registry/auth-cache');
const { checkNewerVersion } = await import('../src/lib/server/semver/check');

function tagsResponse(tags: string[], nextPath?: string) {
	return {
		ok: true,
		json: async () => ({ tags }),
		headers: { get: (h: string) => (h === 'link' && nextPath ? `<${nextPath}>; rel="next"` : null) }
	};
}

describe('fetchGenericV2Tags', () => {
	beforeEach(() => mock.restore());

	it('returns a single page when there is no next link', async () => {
		globalThis.fetch = mock(async () => tagsResponse(['1.0', '1.1'])) as unknown as typeof fetch;
		expect(await fetchGenericV2Tags('codeberg.org', 'forgejo/forgejo')).toEqual({ tags: ['1.0', '1.1'], complete: true });
	});

	it('a 401 on the tag list drops the cached token it was sent with', async () => {
		registryAuthCache.clear();
		await registryAuthCache.get('k', async () => ({ header: 'Bearer test-token', ttlMs: 60_000 }));
		globalThis.fetch = mock(async () => ({ ok: false, status: 401, headers: { get: () => null } })) as unknown as typeof fetch;
		await fetchGenericV2Tags('codeberg.org', 'forgejo/forgejo');
		expect(registryAuthCache.size()).toBe(0);
	});

	it('a 429 on the tag list keeps the cached token', async () => {
		registryAuthCache.clear();
		await registryAuthCache.get('k', async () => ({ header: 'Bearer test-token', ttlMs: 60_000 }));
		globalThis.fetch = mock(async () => ({ ok: false, status: 429, headers: { get: () => null } })) as unknown as typeof fetch;
		await fetchGenericV2Tags('codeberg.org', 'forgejo/forgejo');
		expect(registryAuthCache.size()).toBe(1);
	});

	it('follows the Link header across pages and concatenates', async () => {
		const calls: string[] = [];
		globalThis.fetch = mock(async (url: string) => {
			calls.push(String(url));
			return String(url).includes('last=')
				? tagsResponse(['15.0.2', '15.1.0'])
				: tagsResponse(['14.0.0'], '/v2/forgejo/forgejo/tags/list?last=14.0.0&n=1000');
		}) as unknown as typeof fetch;

		const tags = await fetchGenericV2Tags('codeberg.org', 'forgejo/forgejo');
		expect(tags).toEqual({ tags: ['14.0.0', '15.0.2', '15.1.0'], complete: true });
		expect(calls.length).toBe(2);
	});

	it('stops on a non-ok response and marks the list incomplete', async () => {
		globalThis.fetch = mock(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
		expect(await fetchGenericV2Tags('codeberg.org', 'missing/repo')).toEqual({ tags: [], complete: false });
	});

	it('keeps the pages it read when a later page fails, marked incomplete', async () => {
		globalThis.fetch = mock(async (url: string) =>
			String(url).includes('last=') ? { ok: false, status: 429 } : tagsResponse(['14.0.0'], '/v2/forgejo/forgejo/tags/list?last=14.0.0&n=1000')
		) as unknown as typeof fetch;
		expect(await fetchGenericV2Tags('codeberg.org', 'forgejo/forgejo')).toEqual({ tags: ['14.0.0'], complete: false });
	});

	it('a redirect ends the listing incomplete instead of caching it for hours', async () => {
		globalThis.fetch = mock(async () => ({ ok: false, status: 302 })) as unknown as typeof fetch;
		expect(await fetchGenericV2Tags('codeberg.org', 'forgejo/forgejo')).toEqual({ tags: [], complete: false });
	});

	it('stopping at the page cap is a complete listing', async () => {
		let calls = 0;
		globalThis.fetch = mock(async () => {
			calls++;
			return tagsResponse([`t${calls}`], `/v2/forgejo/forgejo/tags/list?last=t${calls}&n=1000`);
		}) as unknown as typeof fetch;
		const list = await fetchGenericV2Tags('codeberg.org', 'forgejo/forgejo');
		expect(calls).toBe(50);
		expect(list.complete).toBe(true);
		expect(list.tags).toHaveLength(50);
	});

	// SSRF guard: `registry` is image-derived (user-controlled). A blocked host must
	// short-circuit to [] WITHOUT ever calling fetch.
	it('refuses a cloud-metadata / loopback registry host without fetching', async () => {
		for (const host of ['169.254.169.254', '127.0.0.1', 'localhost', '169.254.169.254:80']) {
			const f = mock(async () => tagsResponse(['1.0']));
			globalThis.fetch = f as unknown as typeof fetch;
			expect(await fetchGenericV2Tags(host, 'x/y')).toEqual({ tags: [], complete: true });
			expect(f).not.toHaveBeenCalled();
		}
	});

	it('still allows a LAN registry (self-hosted Harbor)', async () => {
		globalThis.fetch = mock(async () => tagsResponse(['2.0'])) as unknown as typeof fetch;
		expect(await fetchGenericV2Tags('192.168.1.50:5000', 'team/app')).toEqual({ tags: ['2.0'], complete: true });
	});
});

// GHCR lists tags in push order and takes `last` as a cursor in that order (measured:
// last=v3.3.3-openvino on immich-machine-learning returns the tags pushed after it). A repo
// of 200k CI tags holds its releases far past the page cap of a listing from the start.
describe('fetchGenericV2TagsAfter, the tags after the running tag', () => {
	beforeEach(() => mock.restore());

	// A registry in push order; only a few tags near the end are releases.
	function pushOrderRegistry(total: number, releases: Record<number, string>) {
		const all = Array.from({ length: total }, (_, i) => releases[i] ?? `commit-${i}`);
		const calls: string[] = [];
		globalThis.fetch = mock(async (url: string) => {
			calls.push(String(url));
			const u = new URL(String(url));
			const n = Number(u.searchParams.get('n'));
			const last = u.searchParams.get('last');
			const start = last ? all.indexOf(last) + 1 : 0;
			const page = all.slice(start, start + n);
			const end = start + page.length;
			return tagsResponse(page, end < all.length ? `/v2/team/app/tags/list?last=${page[page.length - 1]}&n=${n}` : undefined);
		}) as unknown as typeof fetch;
		return calls;
	}

	it('finds a release pushed after the running tag that a listing from the start misses', async () => {
		const calls = pushOrderRegistry(60_000, { 57_000: 'v3.3.3', 58_500: 'v3.3.4' });
		const after = await fetchGenericV2TagsAfter('ghcr.io', 'team/app', null, 'v3.3.3');
		expect(after.tags).toContain('v3.3.4');
		expect(after.complete).toBe(true);
		// 2,999 tags after v3.3.3: three pages.
		expect(calls.length).toBe(3);
		expect((await fetchGenericV2Tags('ghcr.io', 'team/app')).tags).not.toContain('v3.3.4');
	});

	it('a registry whose `last` is an opaque token (ECR: 405) yields nothing, and is not a failed read', async () => {
		globalThis.fetch = mock(async () => ({ ok: false, status: 405 })) as unknown as typeof fetch;
		expect(await fetchGenericV2TagsAfter('public.ecr.aws', 'docker/library/nginx', null, '1.25')).toEqual({ tags: [], complete: true });
	});

	it('a rate limit or a later page failing is a failed read', async () => {
		globalThis.fetch = mock(async () => ({ ok: false, status: 429 })) as unknown as typeof fetch;
		expect(await fetchGenericV2TagsAfter('ghcr.io', 'team/app', null, 'v1')).toEqual({ tags: [], complete: false });
		globalThis.fetch = mock(async (url: string) =>
			String(url).includes('last=v1&') || String(url).endsWith('last=v1') ? tagsResponse(['v2'], '/v2/team/app/tags/list?last=v2&n=1000') : { ok: false, status: 404 }
		) as unknown as typeof fetch;
		expect(await fetchGenericV2TagsAfter('ghcr.io', 'team/app', null, 'v1')).toEqual({ tags: ['v2'], complete: false });
	});

	it('a cap reached is logged, from either starting point', async () => {
		const warn = mock(() => {});
		const original = console.warn;
		console.warn = warn;
		try {
			pushOrderRegistry(55_000, {});
			await fetchGenericV2Tags('ghcr.io', 'team/app');
			expect(warn).toHaveBeenCalledTimes(1);
			pushOrderRegistry(60_000, { 100: 'v1.0.0' });
			await fetchGenericV2TagsAfter('ghcr.io', 'team/app', null, 'v1.0.0');
			expect(warn).toHaveBeenCalledTimes(2);
			pushOrderRegistry(3_000, { 100: 'v1.0.0' });
			await fetchGenericV2TagsAfter('ghcr.io', 'team/app', null, 'v1.0.0');
			expect(warn).toHaveBeenCalledTimes(2);
		} finally {
			console.warn = original;
		}
	});
});

describe('tagListings', () => {
	it('Docker Hub has one listing per repo', () => {
		expect(tagListings('docker.io', 'library/nginx', '1.25', true)).toEqual([{ key: 'docker.io/library/nginx' }]);
	});

	it('a generic v2 registry adds the tags after the running tag, keyed by it; the start listing is per repo', () => {
		expect(tagListings('ghcr.io', 'team/app', 'v3.3.3', false)).toEqual([
			{ key: 'ghcr.io/team/app@after:v3.3.3', after: 'v3.3.3' },
			{ key: 'ghcr.io/team/app' }
		]);
		// Two tags of one repo share the start listing.
		const a = tagListings('ghcr.io', 'team/app', 'v3.3.3-cuda', false);
		const b = tagListings('ghcr.io', 'team/app', 'v3.3.3-openvino', false);
		expect(a[1].key).toBe(b[1].key);
		expect(a[0].key).not.toBe(b[0].key);
	});
});

describe('the tag cache drops expired entries', () => {
	it('an entry for a tag no longer running does not stay behind', async () => {
		let t = 0;
		const cache = createTagCache(() => t, () => {});
		await cache.get('r@after:v1', async () => ({ tags: ['v2'], complete: true }));
		t += 7 * 60 * 60 * 1000;
		await cache.get('r@after:v2', async () => ({ tags: [], complete: true }));
		expect(cache.size()).toBe(1);
	});
});

describe('listVersionTags merges the listings and shares the start listing across tags', () => {
	beforeEach(() => { mock.restore(); __resetTagSourceCacheForTests(); });

	it('a spec registry: the tags after the running one and the start listing, once each', async () => {
		const calls: string[] = [];
		globalThis.fetch = mock(async (url: string) => {
			calls.push(String(url));
			return String(url).includes('last=') ? tagsResponse(['v3.9.1']) : tagsResponse(['v3.10.0', 'v3.9.0', 'v3.9.1']);
		}) as unknown as typeof fetch;
		const tags = await listVersionTags('registry.example.com/team/app:v3.9.0');
		expect([...tags].sort()).toEqual(['v3.10.0', 'v3.9.0', 'v3.9.1']);

		// A second tag of the same repo reads only its own tail; the start listing is cached.
		await listVersionTags('registry.example.com/team/app:v3.9.1');
		expect(calls.filter((c) => !c.includes('last=')).length).toBe(1);
		expect(calls.filter((c) => c.includes('last=')).length).toBe(2);
	});

	it('a start time after the cached listing lists the tags again', async () => {
		const calls: string[] = [];
		globalThis.fetch = mock(async (url: string) => (calls.push(String(url)), tagsResponse(['2.0']))) as unknown as typeof fetch;
		await listVersionTags('registry.example.com/team/fresh:1.0');
		const listed = calls.length;
		await listVersionTags('registry.example.com/team/fresh:1.0');
		expect(calls.length).toBe(listed);
		await listVersionTags('registry.example.com/team/fresh:1.0', Date.now() + 1);
		expect(calls.length).toBeGreaterThan(listed);
	});

	it('checkNewerVersion passes the start time on, so a manual check sees a tag released since the last listing', async () => {
		let tags = ['1.0'];
		globalThis.fetch = mock(async () => tagsResponse(tags)) as unknown as typeof fetch;
		expect(await checkNewerVersion('registry.example.com/team/released:1.0')).toBeNull();
		tags = ['1.0', '1.1'];
		expect(await checkNewerVersion('registry.example.com/team/released:1.0')).toBeNull();
		expect((await checkNewerVersion('registry.example.com/team/released:1.0', {}, undefined, [], undefined, Date.now() + 1))?.tag).toBe('1.1');
	});

	it('looks up credentials with the image repo, so an org-path registry entry can match', async () => {
		credentialLookups.length = 0;
		globalThis.fetch = mock(async () => tagsResponse(['2.0'])) as unknown as typeof fetch;
		await listVersionTags('registry.example.com/team/app:1.0');
		expect(credentialLookups[0]).toEqual(['registry.example.com', 'team/app']);
	});
});
