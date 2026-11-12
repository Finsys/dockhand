// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, expect, test } from 'bun:test';
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

		expect(await cache.get(1)).toBeNull();
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
});
