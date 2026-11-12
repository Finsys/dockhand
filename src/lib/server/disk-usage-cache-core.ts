/**
 * Per-environment cache for Docker's `/system/df` result.
 *
 * `/system/df` walks every image layer, container writable layer and volume, so on
 * some storage backends (Synology/btrfs, QNAP, slow disks) it takes tens of seconds.
 * Several surfaces ask for it (header host info, dashboard, dashboard stream); without
 * a shared cache each page load started another scan, and because callers only stopped
 * *waiting* on a timeout, the scans kept running on the daemon and piled up.
 *
 * This cache:
 * - returns a fresh-enough result straight from memory (TTL),
 * - shares one in-flight scan per environment between concurrent callers,
 * - lets a caller stop waiting (`waitMs`) without abandoning the scan: the result
 *   still lands in the cache for the next caller,
 * - aborts the underlying request after `hardTimeoutMs` so a scan can't run forever.
 *
 * No `$lib` imports here so it can be unit tested in isolation.
 */

export interface DiskUsageCacheOptions {
	/** How long a successful result is served from memory. */
	ttlMs: number;
	/** Upper bound on cached environments (oldest evicted first). */
	maxEntries: number;
	/** Abort the underlying request after this long. */
	hardTimeoutMs: number;
	/** Clock, injectable for tests. */
	now?: () => number;
}

export type DiskUsageFetcher<T> = (envId: number, signal: AbortSignal) => Promise<T>;

export interface DiskUsageCache<T> {
	/**
	 * Cached result if fresh, otherwise the (shared) in-flight scan.
	 * With `waitMs`, resolves to `null` if the scan hasn't finished in time; the
	 * scan keeps going and fills the cache when it completes.
	 * Never rejects: failures resolve to `null` and are not cached.
	 */
	get(envId: number, waitMs?: number): Promise<T | null>;
	/** True while a scan for this environment is running. */
	isLoading(envId: number): boolean;
	/** Drop cached data (one environment, or all). In-flight scans are left alone. */
	clear(envId?: number): void;
}

export function createDiskUsageCache<T>(
	fetcher: DiskUsageFetcher<T>,
	options: DiskUsageCacheOptions
): DiskUsageCache<T> {
	const now = options.now ?? Date.now;
	const cache = new Map<number, { data: T; timestamp: number }>();
	const inflight = new Map<number, Promise<T | null>>();

	function store(envId: number, data: T) {
		cache.delete(envId); // re-insert so Map order stays oldest-first
		cache.set(envId, { data, timestamp: now() });
		while (cache.size > options.maxEntries) {
			const oldest = cache.keys().next().value;
			if (oldest === undefined) break;
			cache.delete(oldest);
		}
	}

	function load(envId: number): Promise<T | null> {
		const pending = inflight.get(envId);
		if (pending) return pending;

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), options.hardTimeoutMs);
		(timer as { unref?: () => void }).unref?.();

		const promise = (async () => {
			try {
				const data = await fetcher(envId, controller.signal);
				if (data !== null && data !== undefined) store(envId, data);
				return data ?? null;
			} catch {
				return null;
			} finally {
				clearTimeout(timer);
				inflight.delete(envId);
			}
		})();

		inflight.set(envId, promise);
		return promise;
	}

	return {
		get(envId, waitMs) {
			const cached = cache.get(envId);
			if (cached && now() - cached.timestamp < options.ttlMs) {
				return Promise.resolve(cached.data);
			}

			const scan = load(envId);
			if (waitMs === undefined) return scan;

			return new Promise<T | null>((resolve) => {
				const timer = setTimeout(() => resolve(null), waitMs);
				(timer as { unref?: () => void }).unref?.();
				scan.then((data) => {
					clearTimeout(timer);
					resolve(data);
				});
			});
		},
		isLoading(envId) {
			return inflight.has(envId);
		},
		clear(envId) {
			if (envId === undefined) cache.clear();
			else cache.delete(envId);
		}
	};
}
