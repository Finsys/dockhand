/**
 * The tag-list cache behind newer-version detection, kept free of registry
 * I/O so its expiry rules can be tested. A complete list is kept for an hour, so a
 * batch of checks lists each repository once without hiding a new release for long; a
 * list that a failed or cut-off listing produced is kept only briefly, so one rate limit
 * or outage does not hide newer versions.
 */

/** What a listing strategy read: the tags, and whether every page answered. */
export interface TagList {
	tags: string[];
	complete: boolean;
}

export const COMPLETE_TTL_MS = 60 * 60 * 1000;
export const INCOMPLETE_TTL_MS = 10 * 60 * 1000;
/** A check a user started reuses lists listed this recently, so repeated clicks do not relist. */
export const USER_CHECK_REUSE_MS = 60 * 1000;

/** The `listedAfter` for a check a user started at `startedAt`. */
export function userCheckListedAfter(startedAt: number): number {
	return startedAt - USER_CHECK_REUSE_MS;
}

interface CacheEntry {
	tags: string[];
	expiresAt: number;
	/** When the listing that produced this entry started. */
	listedAt: number;
	complete: boolean;
}

export function createTagCache(now: () => number = Date.now, warn: (message: string) => void = console.warn) {
	const cache = new Map<string, CacheEntry>();
	// Concurrent asks for one repo share a single listing.
	const inflight = new Map<string, { promise: Promise<string[]>; listedAt: number }>();

	/**
	 * `listedAfter`: only use a list whose listing started at or after this time, cached or
	 * in flight; an older listing still in flight is waited for and then listed again.
	 */
	async function get(key: string, list: () => Promise<TagList>, listedAfter?: number): Promise<string[]> {
		const fresh = (listedAt: number) => listedAfter === undefined || listedAt >= listedAfter;
		const cached = cache.get(key);
		if (cached && cached.expiresAt > now() && fresh(cached.listedAt)) return cached.tags;

		const pending = inflight.get(key);
		if (pending) {
			if (fresh(pending.listedAt)) return pending.promise;
			await pending.promise.catch(() => {});
			return get(key, list, listedAfter);
		}

		const listedAt = now();
		const promise = (async () => {
			let result: TagList;
			try {
				result = await list();
			} catch (error) {
				result = { tags: [], complete: false };
				warn(`[Semver] Listing tags for ${key} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (!result.complete) {
				// A failed or cut-off relist never replaces a complete list that is still valid.
				const previous = cache.get(key);
				if (previous && previous.complete && previous.expiresAt > now()) {
					warn(`[Semver] Tag list for ${key} is incomplete (${result.tags.length} read); keeping the complete list from before`);
					return previous.tags;
				}
				warn(`[Semver] Tag list for ${key} is incomplete (${result.tags.length} read); listing again in ${INCOMPLETE_TTL_MS / 60000} min`);
			}
			// Keys include the running tag, so expired entries are dropped rather than left behind.
			for (const [k, entry] of cache) if (entry.expiresAt <= now()) cache.delete(k);
			cache.set(key, { tags: result.tags, listedAt, complete: result.complete, expiresAt: now() + (result.complete ? COMPLETE_TTL_MS : INCOMPLETE_TTL_MS) });
			return result.tags;
		})();

		inflight.set(key, { promise, listedAt });
		try {
			return await promise;
		} finally {
			inflight.delete(key);
		}
	}

	function size(): number {
		return cache.size;
	}

	function clear(): void {
		cache.clear();
		inflight.clear();
	}

	return { get, clear, size };
}

/**
 * Which listings an image's newer versions come from, each with its cache key. Docker Hub
 * lists newest first, so one listing per repo. A generic v2 registry adds a listing from
 * the running tag on, keyed by that tag; the listing from the start does not depend on
 * the tag and is shared by every tag of the repo.
 */
export function tagListings(registry: string, repo: string, tag: string, dockerHub: boolean): { key: string; after?: string }[] {
	const repoKey = `${registry}/${repo}`;
	if (dockerHub) return [{ key: repoKey }];
	return [{ key: `${repoKey}@after:${tag}`, after: tag }, { key: repoKey }];
}
