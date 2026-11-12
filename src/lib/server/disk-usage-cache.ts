import { getDiskUsage } from './docker';
import { createDiskUsageCache } from './disk-usage-cache-core';

/** Disable `/system/df` collection entirely (slow NAS storage). */
export const SKIP_DF_COLLECTION =
	process.env.SKIP_DF_COLLECTION === 'true' || process.env.SKIP_DF_COLLECTION === '1';

/**
 * Shared `/system/df` cache for every surface that shows disk usage (header host
 * info, dashboard, dashboard stream). One scan per environment at a time, results
 * reused for 5 minutes, and the request is aborted on the socket after 2 minutes.
 */
const diskUsageCache = createDiskUsageCache<any>(
	(envId, signal) => getDiskUsage(envId, signal),
	{
		ttlMs: 5 * 60 * 1000,
		maxEntries: 100,
		hardTimeoutMs: 2 * 60 * 1000
	}
);

/**
 * Docker disk usage for an environment, or `null` if collection is disabled, it
 * failed, or it didn't finish within `waitMs`. A scan that outlives `waitMs` keeps
 * running and fills the cache for the next caller.
 */
export function getCachedDiskUsage(envId: number, waitMs?: number): Promise<any | null> {
	if (SKIP_DF_COLLECTION) return Promise.resolve(null);
	return diskUsageCache.get(envId, waitMs);
}
