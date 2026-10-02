/**
 * Short-TTL per-environment cache for the aggregated vulnerability findings.
 *
 * Lives in its own module (importing only client-safe types) so that db.ts can
 * invalidate it from inside saveVulnerabilityScan WITHOUT a circular import
 * (vulnerabilities.ts imports db.ts). That way every writer of a scan row
 * automatically refreshes the dashboard — no caller can forget.
 */
import { EMPTY_SUMMARY } from '../utils/vulnerability';
import type { Finding, VulnerabilitySummary } from '$lib/utils/vulnerability';

export const CACHE_TTL_MS = 30_000;
/** Per-env cap on memoized filter/sort views (bounds server memory). */
export const MAX_VIEWS = 8;
/** Cap on cached environments — bounds total memory when many envs are viewed.
 *  Least-recently-inserted env entry is evicted past this. */
export const MAX_ENVS = 16;

export interface AggregatedVulnerabilities {
	findings: Finding[];
	summary: VulnerabilitySummary;
}

export interface VulnerabilitiesMeta {
	total: number;
	summary: VulnerabilitySummary;
	options: { images: string[]; containers: string[]; stacks: string[] };
}

/** Empty meta for the no-environment case — shared so the shape isn't re-typed. */
export const EMPTY_META: VulnerabilitiesMeta = {
	total: 0,
	summary: EMPTY_SUMMARY,
	options: { images: [], containers: [], stacks: [] }
};

export interface CacheEntry {
	at: number;
	data: AggregatedVulnerabilities;
	/** Memoized filtered+sorted arrays within this cache window, keyed by query. */
	views: Map<string, Finding[]>;
	/** Memoized meta (distinct filter options) — computed once per window. */
	meta?: VulnerabilitiesMeta;
}

// Keyed by envId. The null-environment ("local"/default) is keyed as 0 since the
// dashboard aggregation only ever runs for a concrete numeric env id.
export const aggregateCache = new Map<number, CacheEntry>();
/** Collapse concurrent cold-start requests into one aggregation. */
export const inflight = new Map<number, Promise<AggregatedVulnerabilities>>();

/**
 * The header's totals and filter options, cached apart from the findings.
 *
 * They are counted in the database, so they are cheap to hold and worth keeping
 * even when nothing has asked for the findings themselves: the metrics exporter
 * and the count endpoint ask for them repeatedly.
 */
export const metaCache = new Map<number, { at: number; meta: VulnerabilitiesMeta }>();
/** Collapse concurrent cold-start requests into one metadata pass. */
export const metaInflight = new Map<number, Promise<VulnerabilitiesMeta>>();

/**
 * Bumped whenever an environment's scans change.
 *
 * A build already under way cannot be recalled, so it reads this before it
 * started and again before it caches: a number that moved means a scan landed
 * mid-build and the answer is already out of date.
 */
const metaEpoch = new Map<number, number>();
/** Counts invalidations that named no environment, so they reach every one. */
let globalMetaEpoch = 0;

export function currentMetaEpoch(envIdNum: number): number {
	return (metaEpoch.get(envIdNum) ?? 0) + globalMetaEpoch;
}

function bumpMetaEpoch(envIdNum?: number | null): void {
	// A global invalidation has to move environments this map has never seen -
	// the retention job clears every environment at once, and a build in flight
	// for an untouched one would otherwise cache an answer from before the delete.
	if (envIdNum === undefined || envIdNum === null) {
		globalMetaEpoch++;
		return;
	}
	metaEpoch.set(envIdNum, (metaEpoch.get(envIdNum) ?? 0) + 1);
}

/**
 * Drop cached findings. Pass an env id to clear just that environment; pass
 * nothing to clear all (e.g. a broad change where the affected env is unknown).
 */
/** Cache occupancy — for the metrics endpoint. `envs` = cached environments,
 *  `views` = total memoized filter/sort views, `inflight` = cold aggregations running. */
export function getVulnerabilitiesCacheStats(): { envs: number; views: number; inflight: number } {
	let views = 0;
	for (const entry of aggregateCache.values()) views += entry.views.size;
	return { envs: aggregateCache.size, views, inflight: inflight.size };
}

export function invalidateVulnerabilitiesCache(envIdNum?: number | null): void {
	// The meta cache needs its in-flight map dropped for the same reason as the
	// findings one below, and the epoch bumped so a build already past that point
	// discards its now-stale answer instead of installing it with a fresh window.
	bumpMetaEpoch(envIdNum);
	if (envIdNum === undefined || envIdNum === null) {
		metaCache.clear();
		metaInflight.clear();
	} else {
		metaCache.delete(envIdNum);
		metaInflight.delete(envIdNum);
	}
	if (envIdNum === undefined || envIdNum === null) {
		aggregateCache.clear();
		// Also drop in-flight aggregations: one racing a scan-save would otherwise
		// resolve to pre-scan data and get installed with a fresh TTL, masking the
		// new scan for a full window. Dropping it forces the next reader to re-run.
		inflight.clear();
	} else {
		aggregateCache.delete(envIdNum);
		inflight.delete(envIdNum);
	}
}
