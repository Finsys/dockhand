import { describe, expect, test } from 'bun:test';
import {
	currentMetaEpoch,
	invalidateVulnerabilitiesCache,
	metaCache,
	metaInflight,
	CACHE_TTL_MS
} from '../src/lib/server/vulnerabilities-cache';

/**
 * That a scan saved mid-build is not hidden by the answer that build returns.
 *
 * The header is cached for a window, and building it takes seconds on a large
 * environment. A build that started before a scan landed holds a pre-scan answer;
 * caching it afterwards would show the old counts until the window expired, which
 * is exactly what a user checks after running a scan.
 */

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The shape getVulnerabilitiesMeta uses, so the guard is exercised as written. */
async function buildAndCache(env: number, answer: string, delayMs = 20): Promise<string> {
	const cached = metaCache.get(env);
	if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.meta as unknown as string;
	const pending = metaInflight.get(env);
	if (pending) return pending as unknown as Promise<string>;

	const epoch = currentMetaEpoch(env);
	const call = (async () => {
		await tick(delayMs);
		return answer;
	})().finally(() => metaInflight.delete(env));
	metaInflight.set(env, call as never);
	const meta = await call;

	if (currentMetaEpoch(env) !== epoch) return meta;
	metaCache.set(env, { at: Date.now(), meta: meta as never });
	return meta;
}

describe('a scan saved while the header is being built', () => {
	test('the pre-scan answer is not cached', async () => {
		const env = 9001;
		invalidateVulnerabilitiesCache(env);

		const reader = buildAndCache(env, 'before the scan');
		await tick(5);
		invalidateVulnerabilitiesCache(env);
		await reader;

		expect(metaCache.has(env)).toBe(false);
	});

	test('the next caller rebuilds instead of reading a stale window', async () => {
		const env = 9002;
		invalidateVulnerabilitiesCache(env);

		const reader = buildAndCache(env, 'before the scan');
		await tick(5);
		invalidateVulnerabilitiesCache(env);
		await reader;

		expect(await buildAndCache(env, 'after the scan')).toBe('after the scan');
	});

	test('an undisturbed build still caches its answer', async () => {
		// The guard must not make the cache useless.
		const env = 9003;
		invalidateVulnerabilitiesCache(env);
		await buildAndCache(env, 'settled');
		expect(metaCache.get(env)?.meta).toBe('settled' as never);
	});
});

describe('invalidation', () => {
	test('drops the in-flight build as well as the cached answer', async () => {
		// Leaving it would let a later caller join a build that predates the scan.
		const env = 9004;
		const running = buildAndCache(env, 'x', 30);
		expect(metaInflight.has(env)).toBe(true);
		invalidateVulnerabilitiesCache(env);
		expect(metaInflight.has(env)).toBe(false);
		await running;
	});

	test('a global invalidation reaches an environment never seen before', () => {
		// The retention job clears every environment at once; a build in flight for
		// one this map has no entry for must still discard its pre-delete answer.
		const env = 9006;
		const before = currentMetaEpoch(env);
		invalidateVulnerabilitiesCache();
		expect(currentMetaEpoch(env)).toBeGreaterThan(before);
	});

	test('moves the epoch for one environment or for all', () => {
		const env = 9005;
		invalidateVulnerabilitiesCache(env);
		const before = currentMetaEpoch(env);
		invalidateVulnerabilitiesCache(env);
		expect(currentMetaEpoch(env)).toBeGreaterThan(before);

		const afterOne = currentMetaEpoch(env);
		invalidateVulnerabilitiesCache();
		expect(currentMetaEpoch(env)).toBeGreaterThan(afterOne);
	});
});
