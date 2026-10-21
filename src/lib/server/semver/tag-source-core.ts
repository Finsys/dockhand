/**
 * The tag-list cache behind newer-version detection, kept free of registry
 * I/O so its expiry rules can be tested. A complete list is kept for hours (published
 * tags change slowly); a list that a failed or cut-off listing produced is kept only
 * briefly, so one rate limit or outage does not hide newer versions for hours.
 */

/** What a listing strategy read: the tags, and whether every page answered. */
export interface TagList {
	tags: string[];
	complete: boolean;
}

export const COMPLETE_TTL_MS = 6 * 60 * 60 * 1000;
export const INCOMPLETE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
	tags: string[];
	expiresAt: number;
}

export function createTagCache(now: () => number = Date.now, warn: (message: string) => void = console.warn) {
	const cache = new Map<string, CacheEntry>();
	// Concurrent asks for one repo share a single listing.
	const inflight = new Map<string, Promise<string[]>>();

	async function get(key: string, list: () => Promise<TagList>): Promise<string[]> {
		const cached = cache.get(key);
		if (cached && cached.expiresAt > now()) return cached.tags;

		const pending = inflight.get(key);
		if (pending) return pending;

		const promise = (async () => {
			let result: TagList;
			try {
				result = await list();
			} catch (error) {
				result = { tags: [], complete: false };
				warn(`[Semver] Listing tags for ${key} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (!result.complete) {
				warn(`[Semver] Tag list for ${key} is incomplete (${result.tags.length} read); listing again in ${INCOMPLETE_TTL_MS / 60000} min`);
			}
			// Keys include the running tag, so expired entries are dropped rather than left behind.
			for (const [k, entry] of cache) if (entry.expiresAt <= now()) cache.delete(k);
			cache.set(key, { tags: result.tags, expiresAt: now() + (result.complete ? COMPLETE_TTL_MS : INCOMPLETE_TTL_MS) });
			return result.tags;
		})();

		inflight.set(key, promise);
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
