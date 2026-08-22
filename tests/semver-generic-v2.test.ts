/**
 * Generic Registry v2 tag listing: the Link-header pagination that keeps newer
 * version tags from being lost behind a first page of git-hash tags.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

// The strategy resolves auth through docker.ts's getRegistryAuthHeader; stub it so
// the test never touches the network or the native docker module.
mock.module('../src/lib/server/docker', () => ({
	getRegistryAuthHeader: async () => 'Bearer test-token'
}));

const { fetchGenericV2Tags } = await import('../src/lib/server/semver/strategies/generic-v2');

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
		expect(await fetchGenericV2Tags('codeberg.org', 'forgejo/forgejo')).toEqual(['1.0', '1.1']);
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
		expect(tags).toEqual(['14.0.0', '15.0.2', '15.1.0']);
		expect(calls.length).toBe(2);
	});

	it('stops and returns what it has on a non-ok response', async () => {
		globalThis.fetch = mock(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
		expect(await fetchGenericV2Tags('codeberg.org', 'missing/repo')).toEqual([]);
	});

	// SSRF guard: `registry` is image-derived (user-controlled). A blocked host must
	// short-circuit to [] WITHOUT ever calling fetch.
	it('refuses a cloud-metadata / loopback registry host without fetching', async () => {
		for (const host of ['169.254.169.254', '127.0.0.1', 'localhost', '169.254.169.254:80']) {
			const f = mock(async () => tagsResponse(['1.0']));
			globalThis.fetch = f as unknown as typeof fetch;
			expect(await fetchGenericV2Tags(host, 'x/y')).toEqual([]);
			expect(f).not.toHaveBeenCalled();
		}
	});

	it('still allows a LAN registry (self-hosted Harbor)', async () => {
		globalThis.fetch = mock(async () => tagsResponse(['2.0'])) as unknown as typeof fetch;
		expect(await fetchGenericV2Tags('192.168.1.50:5000', 'team/app')).toEqual(['2.0']);
	});
});
