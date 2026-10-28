/**
 * The newer-version tag-list cache: a complete list is kept for an hour, a list that a
 * failed or cut-off listing produced only briefly, so one rate limit does not hide
 * newer versions; a manual check reads only lists listed during that check. Plus the
 * Hub strategy's completeness signal.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { createTagCache, COMPLETE_TTL_MS, INCOMPLETE_TTL_MS, USER_CHECK_REUSE_MS, userCheckListedAfter, type TagList } from '../src/lib/server/semver/tag-source-core';
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

describe('a fresh read for a manual check', () => {
	test('a list listed before the check started is listed again, one listed during it is reused', async () => {
		const s = setup();
		const list = s.lister({ tags: ['1.0'], complete: true });
		await s.cache.get('k', list);
		s.advance(1000);
		const checkStart = 1_000_000 + 1000;
		await s.cache.get('k', list, checkStart);
		expect(s.calls()).toBe(2);
		// Another container of the same repository in the same check shares that listing.
		s.advance(500);
		await s.cache.get('k', list, checkStart);
		expect(s.calls()).toBe(2);
		// A list listed exactly at the check start counts as listed during it.
		await s.cache.get('k2', list);
		await s.cache.get('k2', list, 1_000_000 + 1500);
		expect(s.calls()).toBe(3);
	});

	test('a relist that fails keeps the complete list from before, for this check and later ones', async () => {
		const s = setup();
		await s.cache.get('k', s.lister({ tags: ['1.0', '1.1'], complete: true }));
		s.advance(5 * 60 * 1000);
		const failing = s.lister(new Error('429'));
		expect(await s.cache.get('k', failing, 1_000_000 + 5 * 60 * 1000)).toEqual(['1.0', '1.1']);
		expect(await s.cache.get('k', failing)).toEqual(['1.0', '1.1']);
		expect(s.calls()).toBe(2);
		// An empty list read from a page that failed is treated the same way.
		expect(await s.cache.get('k', s.lister({ tags: [], complete: false }), 1_000_000 + 5 * 60 * 1000 + 1)).toEqual(['1.0', '1.1']);
	});

	test('only a complete list is kept over a relist; an older partial list gives way to a newer one', async () => {
		const s = setup();
		await s.cache.get('k', s.lister({ tags: ['1.0'], complete: false }));
		s.advance(1000);
		expect(await s.cache.get('k', s.lister({ tags: ['1.0', '1.1'], complete: false }), 1_000_000 + 1000)).toEqual(['1.0', '1.1']);
	});

	test('a listing still in flight from before the start is waited for, then listed again', async () => {
		const s = setup();
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let n = 0;
		const slow = async () => { n++; if (n === 1) await gate; return { tags: [`v${n}`], complete: true }; };
		const scheduled = s.cache.get('k', slow);
		s.advance(1000);
		const manual = s.cache.get('k', slow, 1_000_000 + 1000);
		release();
		expect(await scheduled).toEqual(['v1']);
		expect(await manual).toEqual(['v2']);
	});

	test('a listing in flight that started after the start time is shared', async () => {
		const s = setup();
		let n = 0;
		const list = async () => ({ tags: [`v${++n}`], complete: true });
		const [a, b] = await Promise.all([s.cache.get('k', list, 1_000_000), s.cache.get('k', list, 1_000_000)]);
		expect([a, b, n]).toEqual([['v1'], ['v1'], 1]);
	});

	test('a list counts as listed when its listing started, not when it finished', async () => {
		const s = setup();
		const slow = async () => { s.advance(2000); return { tags: ['1.0'], complete: true }; };
		await s.cache.get('k', slow);
		let again = 0;
		await s.cache.get('k', async () => (again++, { tags: ['1.0'], complete: true }), 1_000_000 + 1000);
		expect(again).toBe(1);
	});

	test('a user check reuses lists listed in the minute before it, not older ones', () => {
		expect(USER_CHECK_REUSE_MS).toBe(60 * 1000);
		expect(userCheckListedAfter(10_000_000)).toBe(10_000_000 - 60 * 1000);
	});

	test('without a start time the cached list is reused as before', async () => {
		const s = setup();
		const list = s.lister({ tags: ['1.0'], complete: true });
		await s.cache.get('k', list);
		s.advance(1000);
		await s.cache.get('k', list);
		expect(s.calls()).toBe(1);
	});
});

describe('tag-list cache expiry', () => {
	test('a complete list is reused for an hour', async () => {
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

	test('an incomplete list is used but listed again after minutes', async () => {
		const s = setup();
		const list = s.lister({ tags: ['1.0'], complete: false });
		expect(await s.cache.get('ghcr.io/a/b', list)).toEqual(['1.0']);
		s.advance(INCOMPLETE_TTL_MS - 1);
		await s.cache.get('ghcr.io/a/b', list);
		expect(s.calls()).toBe(1);
		s.advance(2);
		await s.cache.get('ghcr.io/a/b', list);
		expect(s.calls()).toBe(2);
		expect(INCOMPLETE_TTL_MS).toBeLessThan(COMPLETE_TTL_MS);
		expect(INCOMPLETE_TTL_MS).toBe(10 * 60 * 1000);
		// A new release must show within an hour, not after a restart.
		expect(COMPLETE_TTL_MS).toBe(60 * 60 * 1000);
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
