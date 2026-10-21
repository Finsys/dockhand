/**
 * The newer-version tag-list cache: a complete list is kept for hours, a list that a
 * failed or cut-off listing produced only briefly, so one rate limit does not hide
 * newer versions for hours. Plus the Hub strategy's completeness signal.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { createTagCache, COMPLETE_TTL_MS, INCOMPLETE_TTL_MS, type TagList } from '../src/lib/server/semver/tag-source-core';
import { fetchDockerHubTags } from '../src/lib/server/semver/strategies/docker-hub';

function setup() {
	let t = 1_000_000;
	const warnings: string[] = [];
	const cache = createTagCache(() => t, (m) => warnings.push(m));
	let calls = 0;
	const lister = (answer: TagList | Error) => async () => {
		calls++;
		if (answer instanceof Error) throw answer;
		return answer;
	};
	return { cache, warnings, advance: (ms: number) => { t += ms; }, calls: () => calls, lister };
}

describe('tag-list cache expiry', () => {
	test('a complete list is reused for hours', async () => {
		const s = setup();
		const list = s.lister({ tags: ['1.0', '1.1'], complete: true });
		expect(await s.cache.get('ghcr.io/a/b', list)).toEqual(['1.0', '1.1']);
		s.advance(COMPLETE_TTL_MS - 1);
		await s.cache.get('ghcr.io/a/b', list);
		expect(s.calls()).toBe(1);
		s.advance(1); // exactly the TTL: expired
		await s.cache.get('ghcr.io/a/b', list);
		expect(s.calls()).toBe(2);
		expect(s.warnings).toEqual([]);
	});

	test('an incomplete list is used but listed again after minutes, not hours', async () => {
		const s = setup();
		const list = s.lister({ tags: ['1.0'], complete: false });
		expect(await s.cache.get('ghcr.io/a/b', list)).toEqual(['1.0']);
		s.advance(INCOMPLETE_TTL_MS - 1);
		await s.cache.get('ghcr.io/a/b', list);
		expect(s.calls()).toBe(1);
		s.advance(2);
		await s.cache.get('ghcr.io/a/b', list);
		expect(s.calls()).toBe(2);
		expect(INCOMPLETE_TTL_MS).toBeLessThan(COMPLETE_TTL_MS / 10);
		expect(INCOMPLETE_TTL_MS).toBe(10 * 60 * 1000);
		expect(COMPLETE_TTL_MS).toBe(6 * 60 * 60 * 1000);
		expect(s.warnings[0]).toContain('incomplete');
	});

	test('a listing that throws yields no tags, is logged, and is retried soon', async () => {
		const s = setup();
		const list = s.lister(new Error('fetch failed'));
		expect(await s.cache.get('ghcr.io/a/b', list)).toEqual([]);
		expect(s.warnings[0]).toContain('fetch failed');
		s.advance(INCOMPLETE_TTL_MS + 1);
		await s.cache.get('ghcr.io/a/b', list);
		expect(s.calls()).toBe(2);
	});

	test('concurrent asks for one repo share one listing', async () => {
		const s = setup();
		let release!: (v: TagList) => void;
		let calls = 0;
		const list = () => { calls++; return new Promise<TagList>((r) => { release = r; }); };
		const a = s.cache.get('ghcr.io/a/b', list);
		const b = s.cache.get('ghcr.io/a/b', list);
		release({ tags: ['2.0'], complete: true });
		expect(await a).toEqual(['2.0']);
		expect(await b).toEqual(['2.0']);
		expect(calls).toBe(1);
	});
});

describe('fetchDockerHubTags completeness', () => {
	const realFetch = globalThis.fetch;
	afterAll(() => { globalThis.fetch = realFetch; });
	const page = (names: string[], next: boolean) =>
		new Response(JSON.stringify({ results: names.map((name) => ({ name })), next: next ? 'more' : null }));

	test('every page answered is complete', async () => {
		globalThis.fetch = (async (url: string) => page(String(url).includes('page=1&') ? ['2.0'] : ['1.0'], String(url).includes('page=1&'))) as unknown as typeof fetch;
		expect(await fetchDockerHubTags('library/nginx')).toEqual({ tags: ['2.0', '1.0'], complete: true });
	});

	test('a failed later page keeps the earlier tags, marked incomplete', async () => {
		globalThis.fetch = (async (url: string) =>
			String(url).includes('page=1&') ? page(['2.0'], true) : new Response('', { status: 429 })) as unknown as typeof fetch;
		expect(await fetchDockerHubTags('library/nginx')).toEqual({ tags: ['2.0'], complete: false });
	});

	test('a failed first page is an empty, incomplete list', async () => {
		globalThis.fetch = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
		expect(await fetchDockerHubTags('library/nginx')).toEqual({ tags: [], complete: false });
	});
});
