/**
 * Unit tests for the vulnerability aggregation cache.
 *
 * This module is deliberately db-free (it imports only client-safe types) so
 * it can be exercised under `bun test` without pulling in better-sqlite3 — the
 * whole reason the cache was extracted from vulnerabilities.ts. These tests
 * pin down the invalidation semantics that saveVulnerabilityScan relies on.
 */
import { test, expect, beforeEach } from 'bun:test';
import {
	aggregateCache,
	inflight,
	invalidateVulnerabilitiesCache,
	CACHE_TTL_MS,
	MAX_VIEWS,
	type CacheEntry,
	type AggregatedVulnerabilities
} from '../src/lib/server/vulnerabilities-cache';

function makeEntry(): CacheEntry {
	const data: AggregatedVulnerabilities = {
		findings: [],
		summary: { total: 0, critical: 0, high: 0, medium: 0, low: 0, imagesScanned: 0, totalImages: 0 }
	};
	return { at: 0, data, views: new Map() };
}

beforeEach(() => {
	aggregateCache.clear();
	inflight.clear();
});

test('exports sane constants', () => {
	expect(CACHE_TTL_MS).toBe(30_000);
	expect(MAX_VIEWS).toBe(8);
});

test('invalidate with an env id drops only that environment', () => {
	aggregateCache.set(1, makeEntry());
	aggregateCache.set(2, makeEntry());

	invalidateVulnerabilitiesCache(1);

	expect(aggregateCache.has(1)).toBe(false);
	expect(aggregateCache.has(2)).toBe(true);
});

test('invalidate with no argument clears every environment', () => {
	aggregateCache.set(1, makeEntry());
	aggregateCache.set(2, makeEntry());

	invalidateVulnerabilitiesCache();

	expect(aggregateCache.size).toBe(0);
});

test('invalidate with null clears every environment (unknown-env broad change)', () => {
	aggregateCache.set(1, makeEntry());
	aggregateCache.set(2, makeEntry());

	invalidateVulnerabilitiesCache(null);

	expect(aggregateCache.size).toBe(0);
});

test('invalidating a missing env id is a no-op, not an error', () => {
	aggregateCache.set(5, makeEntry());

	expect(() => invalidateVulnerabilitiesCache(999)).not.toThrow();
	expect(aggregateCache.size).toBe(1);
	expect(aggregateCache.has(5)).toBe(true);
});

test('null-environment scans key under 0', () => {
	// saveVulnerabilityScan passes `data.environmentId ?? undefined`; a null env
	// therefore invalidates env 0, which is where the dashboard aggregates it.
	aggregateCache.set(0, makeEntry());

	invalidateVulnerabilitiesCache(0);

	expect(aggregateCache.has(0)).toBe(false);
});

test('invalidating an env also drops its in-flight aggregation', () => {
	// A fetch racing a scan-save would otherwise resolve to pre-scan data and be
	// installed with a fresh TTL, masking the new scan for a full window.
	inflight.set(4, Promise.resolve({
		findings: [],
		summary: { total: 0, critical: 0, high: 0, medium: 0, low: 0, imagesScanned: 0, totalImages: 0 }
	}));
	inflight.set(5, Promise.resolve({
		findings: [],
		summary: { total: 0, critical: 0, high: 0, medium: 0, low: 0, imagesScanned: 0, totalImages: 0 }
	}));

	invalidateVulnerabilitiesCache(4);
	expect(inflight.has(4)).toBe(false);
	expect(inflight.has(5)).toBe(true); // other env untouched

	invalidateVulnerabilitiesCache(); // clear-all also clears inflight
	expect(inflight.size).toBe(0);
});

test('invalidation drops memoized views along with the entry', () => {
	const entry = makeEntry();
	entry.views.set('some-query', []);
	entry.meta = {
		total: 0,
		summary: { total: 0, critical: 0, high: 0, medium: 0, low: 0, imagesScanned: 0, totalImages: 0 },
		options: { images: [], containers: [], stacks: [] }
	};
	aggregateCache.set(3, entry);

	invalidateVulnerabilitiesCache(3);

	// Whole entry gone → its views/meta are gone too; a refetch rebuilds them.
	expect(aggregateCache.get(3)).toBeUndefined();
});
