// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, expect, spyOn, test } from 'bun:test';
import { createDiskUsageCache } from '../src/lib/server/disk-usage-cache-core';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetcher whose calls resolve only when the test says so. */
function controllableFetcher<T>() {
	const calls: { envId: number; signal: AbortSignal; resolve: (v: T) => void; reject: (e: unknown) => void }[] = [];
	const fetcher = (envId: number, signal: AbortSignal) =>
		new Promise<T>((resolve, reject) => {
			calls.push({ envId, signal, resolve, reject });
			signal.addEventListener('abort', () => reject(new Error('aborted')));
		});
	return { fetcher, calls };
}

const opts = { ttlMs: 1000, maxEntries: 10, hardTimeoutMs: 10_000 };

describe('createDiskUsageCache', () => {
	test('concurrent callers share one scan per environment', async () => {
		const { fetcher, calls } = controllableFetcher<{ n: number }>();
		const cache = createDiskUsageCache(fetcher, opts);

		const a = cache.get(1);
		const b = cache.get(1);
		const c = cache.get(2);
		expect(calls.length).toBe(2);
		expect(cache.isLoading(1)).toBe(true);

		calls[0].resolve({ n: 1 });
		calls[1].resolve({ n: 2 });
		expect(await a).toEqual({ n: 1 });
		expect(await b).toEqual({ n: 1 });
		expect(await c).toEqual({ n: 2 });
		expect(cache.isLoading(1)).toBe(false);
	});

	test('serves the cached result within the TTL and refetches after it', async () => {
		let clock = 0;
		let fetches = 0;
		const cache = createDiskUsageCache(async () => ({ n: ++fetches }), { ...opts, now: () => clock });

		expect(await cache.get(1)).toEqual({ n: 1 });
		clock = 999;
		expect(await cache.get(1)).toEqual({ n: 1 });
		clock = 1000;
		expect(await cache.get(1)).toEqual({ n: 2 });
		expect(fetches).toBe(2);
	});

	test('waitMs gives up with null but the scan still fills the cache', async () => {
		const { fetcher, calls } = controllableFetcher<{ n: number }>();
		const cache = createDiskUsageCache(fetcher, opts);

		expect(await cache.get(1, 20)).toBeNull();
		expect(cache.isLoading(1)).toBe(true);
		expect(calls[0].signal.aborted).toBe(false);

		// A second impatient caller must not start another scan
		expect(await cache.get(1, 20)).toBeNull();
		expect(calls.length).toBe(1);

		calls[0].resolve({ n: 7 });
		await sleep(0);
		expect(await cache.get(1, 20)).toEqual({ n: 7 });
		expect(calls.length).toBe(1);
	});

	test('aborts the underlying request after hardTimeoutMs and resolves null', async () => {
		const { fetcher, calls } = controllableFetcher<{ n: number }>();
		const cache = createDiskUsageCache(fetcher, { ...opts, hardTimeoutMs: 20 });

		expect(await cache.get(1)).toBeNull();
		expect(calls[0].signal.aborted).toBe(true);
		expect(cache.isLoading(1)).toBe(false);
	});

	test('failures resolve to null, are not cached, and the next call retries', async () => {
		let fail = true;
		let fetches = 0;
		const cache = createDiskUsageCache(async () => {
			fetches++;
			if (fail) throw new Error('docker down');
			return { ok: true };
		}, opts);

		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect(await cache.get(1)).toBeNull();
			// A failed scan is logged with its environment, not swallowed silently.
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0][0])).toContain('env 1');
			expect(String(warn.mock.calls[0][1])).toBe('docker down');
		} finally {
			warn.mockRestore();
		}
		fail = false;
		expect(await cache.get(1)).toEqual({ ok: true });
		expect(fetches).toBe(2);
	});

	test('evicts the oldest environments beyond maxEntries', async () => {
		let fetches = 0;
		const cache = createDiskUsageCache(async (envId) => ({ envId, n: ++fetches }), { ...opts, maxEntries: 2 });

		await cache.get(1);
		await cache.get(2);
		await cache.get(3); // evicts 1
		expect(await cache.get(2)).toEqual({ envId: 2, n: 2 });
		expect(await cache.get(1)).toEqual({ envId: 1, n: 4 });
	});

	test('clear() drops cached data', async () => {
		let fetches = 0;
		const cache = createDiskUsageCache(async () => ({ n: ++fetches }), opts);
		await cache.get(1);
		cache.clear(1);
		expect(await cache.get(1)).toEqual({ n: 2 });
	});

	test('a waitMs caller gets the data when the scan finishes inside the window', async () => {
		const { fetcher, calls } = controllableFetcher<{ n: number }>();
		const cache = createDiskUsageCache(fetcher, opts);
		const pending = cache.get(1, 1000);
		calls[0].resolve({ n: 3 });
		expect(await pending).toEqual({ n: 3 });
	});

	test('a slow scan the transport cannot abort runs once and still fills the cache', async () => {
		// A local socket ignores the abort: the scan outlives hardTimeoutMs and lands later.
		let fetches = 0;
		let land: (v: { n: number }) => void = () => {};
		const cache = createDiskUsageCache(() => {
			fetches++;
			return new Promise<{ n: number }>((resolve) => { land = resolve; });
		}, { ...opts, hardTimeoutMs: 10, giveUpMs: 1000 });
		expect(await cache.get(1, 5)).toBeNull();
		await sleep(30); // past hardTimeoutMs: the abort fired, the request did not stop
		expect(await cache.get(1, 5)).toBeNull();
		expect(fetches).toBe(1); // still one scan per environment
		land({ n: 9 });
		await sleep(0);
		expect(await cache.get(1, 5)).toEqual({ n: 9 });
		expect(fetches).toBe(1);
	});

	test('giveUpMs frees the environment when the transport ignores the signal and hangs', async () => {
		// A local-socket request does not react to the abort; the scan never settles.
		let fetches = 0;
		const cache = createDiskUsageCache(() => {
			fetches++;
			return new Promise<{ n: number }>(() => {});
		}, { ...opts, hardTimeoutMs: 10, giveUpMs: 20 });
		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect(await cache.get(1)).toBeNull();
			expect(cache.isLoading(1)).toBe(false);
			// The next caller starts a new scan instead of waiting on the stuck one.
			void cache.get(1, 5);
			expect(fetches).toBe(2);
		} finally {
			warn.mockRestore();
		}
	});

	test('a fetcher that throws synchronously still frees the environment', async () => {
		let fetches = 0;
		const cache = createDiskUsageCache((): Promise<{ n: number }> => {
			fetches++;
			throw new Error('boom');
		}, opts);
		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect(await cache.get(1)).toBeNull();
			expect(cache.isLoading(1)).toBe(false);
			expect(await cache.get(1)).toBeNull();
			expect(fetches).toBe(2);
		} finally {
			warn.mockRestore();
		}
	});

	test('clear(envId) during a scan: a stale result arriving last never replaces the fresh one', async () => {
		const { fetcher, calls } = controllableFetcher<{ n: number }>();
		const cache = createDiskUsageCache(fetcher, opts);
		const before = cache.get(1);
		cache.clear(1); // e.g. a prune finished while the scan was running
		expect(cache.isLoading(1)).toBe(false);
		const after = cache.get(1);
		expect(calls.length).toBe(2);
		calls[1].resolve({ n: 2 }); // the fresh scan finishes first
		expect(await after).toEqual({ n: 2 });
		calls[0].resolve({ n: 1 }); // the scan from before the clear finishes last
		expect(await before).toEqual({ n: 1 });
		expect(await cache.get(1)).toEqual({ n: 2 });
		expect(calls.length).toBe(2);
	});

	test('a stale scan finishing first does not free the slot of the fresh one', async () => {
		const { fetcher, calls } = controllableFetcher<{ n: number }>();
		const cache = createDiskUsageCache(fetcher, opts);
		const before = cache.get(1);
		cache.clear(1);
		const after = cache.get(1);
		calls[0].resolve({ n: 1 });
		await before;
		expect(cache.isLoading(1)).toBe(true);
		void cache.get(1, 5); // shares the fresh scan, starts nothing new
		expect(calls.length).toBe(2);
		calls[1].resolve({ n: 2 });
		expect(await after).toEqual({ n: 2 });
	});

	test('clear() during a scan drops its result for every environment', async () => {
		const { fetcher, calls } = controllableFetcher<{ n: number }>();
		const cache = createDiskUsageCache(fetcher, opts);
		const before = cache.get(1);
		cache.clear();
		const after = cache.get(1);
		calls[1].resolve({ n: 2 });
		await after;
		calls[0].resolve({ n: 1 });
		await before;
		expect(await cache.get(1)).toEqual({ n: 2 });
	});

	test('clear(envId) leaves other environments; clear() drops them all', async () => {
		let fetches = 0;
		const cache = createDiskUsageCache(async (envId) => ({ envId, n: ++fetches }), opts);
		await cache.get(1);
		await cache.get(2);
		cache.clear(1);
		expect(await cache.get(2)).toEqual({ envId: 2, n: 2 });
		expect(await cache.get(1)).toEqual({ envId: 1, n: 3 });
		cache.clear();
		expect(await cache.get(1)).toEqual({ envId: 1, n: 4 });
		expect(await cache.get(2)).toEqual({ envId: 2, n: 5 });
	});

	test('a refreshed entry counts as newest for eviction', async () => {
		let clock = 0;
		let fetches = 0;
		const cache = createDiskUsageCache(async (envId) => ({ envId, n: ++fetches }), { ...opts, maxEntries: 2, now: () => clock });
		await cache.get(1);
		await cache.get(2);
		clock = 1000; // both expire
		await cache.get(1); // refreshed: now newer than 2
		clock = 1500;
		await cache.get(3); // evicts the oldest, which is 2
		expect(fetches).toBe(4);
		expect(await cache.get(1)).toEqual({ envId: 1, n: 3 });
		expect(fetches).toBe(4);
		expect(await cache.get(2)).toEqual({ envId: 2, n: 5 });
	});

	test('a scan freed by giveUpMs is stored when it lands, but never over a newer result', async () => {
		const lands: ((v: { n: string }) => void)[] = [];
		const cache = createDiskUsageCache(
			() => new Promise<{ n: string }>((resolve) => { lands.push(resolve); }),
			{ ...opts, hardTimeoutMs: 5, giveUpMs: 15 }
		);
		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect(await cache.get(1)).toBeNull(); // scan A given up
			lands[0]({ n: 'late' });
			await sleep(0);
			expect(await cache.get(1, 5)).toEqual({ n: 'late' }); // a late result still fills the cache

			cache.clear(1);
			expect(await cache.get(1)).toBeNull(); // scan B given up
			const fresh = cache.get(1); // scan C
			lands[2]({ n: 'new' });
			expect(await fresh).toEqual({ n: 'new' });
			lands[1]({ n: 'old' }); // B lands after C
			await sleep(0);
			expect(await cache.get(1, 5)).toEqual({ n: 'new' });
		} finally {
			warn.mockRestore();
		}
	});

	test('giveUpMs defaults to five times hardTimeoutMs', async () => {
		const cache = createDiskUsageCache(() => new Promise<{ n: number }>(() => {}), { ...opts, hardTimeoutMs: 10 });
		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			void cache.get(1);
			await sleep(30);
			expect(cache.isLoading(1)).toBe(true);
			await sleep(45);
			expect(cache.isLoading(1)).toBe(false);
		} finally {
			warn.mockRestore();
		}
	});

	test('a null or undefined result is not cached', async () => {
		let fetches = 0;
		const results = [null, undefined, { n: 1 }];
		const cache = createDiskUsageCache(async () => results[fetches++] as { n: number } | null, opts);
		expect(await cache.get(1)).toBeNull();
		expect(await cache.get(1)).toBeNull();
		expect(await cache.get(1)).toEqual({ n: 1 });
		expect(fetches).toBe(3);
	});

	test('a successful scan cancels the deadline timer', async () => {
		const { fetcher, calls } = controllableFetcher<{ n: number }>();
		const cache = createDiskUsageCache(fetcher, { ...opts, hardTimeoutMs: 20 });
		const pending = cache.get(1);
		calls[0].resolve({ n: 1 });
		await pending;
		await sleep(40);
		expect(calls[0].signal.aborted).toBe(false);
	});
});
