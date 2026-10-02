/**
 * Short-lived cache for live provider probes.
 *
 * The stack editor probes the bound provider to classify a compose ${VAR} as
 * present ("IN VAULT") or missing. Without protection a busy editor page (debounced
 * keystrokes + the list auto-refresh) fires overlapping probes, and each one would
 * hit the provider: wasted 1Password/Vault API calls, and for the CLI providers a
 * burst of keepassxc-cli/bws spawns (each re-deriving the key). Two guards:
 *   - a ~30s result cache (KEY NAMES only, never values), and
 *   - single-flight: probes for the same (providerId, selector) that arrive while a
 *     call is already in flight share that one Promise instead of spawning their own.
 */

import type { SecretProvider, SecretProviderConfig } from './shared';

const TTL_MS = 30_000;

interface Entry {
	keys: string[];
	at: number;
}

// Keyed by `${providerId}:${selector}`. A stale entry is deleted when read, so the
// map self-trims to selectors probed within the TTL window rather than growing
// forever across a live editing session (every keystroke is a distinct selector).
const cache = new Map<string, Entry>();

// In-flight probes, keyed the same way, so concurrent callers coalesce onto one
// provider call. Cleared when the call settles (success or failure).
const inflight = new Map<string, Promise<string[]>>();

// Same two guards for the INLINE op:// reference probe (resolveSecretReferences),
// keyed by (providerId + the sorted ref set). Separate maps from the bulk ones so a
// bulk selector and a set of refs never collide. This is the path that drained the
// 1Password limit "just by opening the editor" (#1436): runProbe fires on open and
// on every debounced edit, and each fire resolved every op:// ref again with no cache.
const refsCache = new Map<string, Entry>();
const refsInflight = new Map<string, Promise<string[]>>();

// In-flight guard for the one-session combined path, keyed by both sides' cache keys.
const combinedInflight = new Map<
	string,
	Promise<{ bulkKeys: string[]; resolvedRefs: string[] }>
>();

/** Stable cache key for a ref set: order-independent (sorted) so the same refs typed
 *  in a different order hit one entry, and JSON-encoded so a ref value that itself
 *  contains the separator can't collide two different sets onto one key. */
function refsKey(providerId: number, refs: string[]): string {
	return `${providerId}:${JSON.stringify([...refs].sort())}`;
}

/**
 * Returns the KEY NAMES available under a provider's bulk selector, cached for
 * ~30s per (providerId, selector). Values are discarded immediately - only the
 * names are stored and returned. Concurrent callers for the same key coalesce onto
 * a single provider call. Propagates the provider's errors to the caller.
 */
export async function probeBulkKeysCached(
	providerId: number,
	provider: SecretProvider,
	config: SecretProviderConfig,
	selector: string
): Promise<string[]> {
	const cacheKey = `${providerId}:${selector}`;
	const now = Date.now();
	const hit = cache.get(cacheKey);
	if (hit) {
		if (now - hit.at < TTL_MS) return hit.keys;
		cache.delete(cacheKey); // stale: drop it so the map doesn't grow unbounded
	}

	// Coalesce onto an existing in-flight call for the same key.
	const pending = inflight.get(cacheKey);
	if (pending) return pending;

	const call = (async () => {
		const bulk = await provider.resolveBulk(config, selector);
		const keys = Object.keys(bulk);
		cache.set(cacheKey, { keys, at: Date.now() });
		return keys;
	})().finally(() => {
		inflight.delete(cacheKey);
	});

	inflight.set(cacheKey, call);
	return call;
}

/**
 * Returns which of the given inline op:// (etc.) references currently RESOLVE in the
 * provider, cached ~30s per (providerId, ref set) with the same single-flight guard as
 * the bulk path. Only the resolved reference STRINGS are returned - secret values are
 * discarded immediately, never stored. This is what keeps the editor's live probe from
 * re-billing the provider's rate limit on every open and every debounced keystroke.
 * Propagates the provider's errors to the caller.
 */
export async function probeRefsCached(
	providerId: number,
	provider: SecretProvider,
	config: SecretProviderConfig,
	refs: string[]
): Promise<string[]> {
	if (refs.length === 0) return [];

	const cacheKey = refsKey(providerId, refs);
	const now = Date.now();
	const hit = refsCache.get(cacheKey);
	if (hit) {
		if (now - hit.at < TTL_MS) return hit.keys;
		refsCache.delete(cacheKey);
	}

	const pending = refsInflight.get(cacheKey);
	if (pending) return pending;

	const call = (async () => {
		const resolved = await provider.resolveSecretReferences(config, refs);
		const names = [...resolved.keys()]; // ref strings only; values dropped
		refsCache.set(cacheKey, { keys: names, at: Date.now() });
		return names;
	})().finally(() => {
		refsInflight.delete(cacheKey);
	});

	refsInflight.set(cacheKey, call);
	return call;
}

/**
 * The editor probe needs BOTH the bulk key names and the resolved refs. A CLI
 * provider pays a full login per backend call, so asking for them separately
 * costs two logins for one keystroke. When the provider can do both in one
 * session, and BOTH sides are cache-cold, take that path; otherwise fall back to
 * the two cached calls (a warm side must still be served from cache, never
 * re-fetched just to share a session).
 *
 * Errors propagate exactly as the separate calls would, so the caller's
 * UnsupportedOperationError handling is unchanged.
 */
export async function probeCombinedCached(
	providerId: number,
	provider: SecretProvider,
	config: SecretProviderConfig,
	selector: string | undefined,
	refs: string[]
): Promise<{ bulkKeys: string[]; resolvedRefs: string[] }> {
	const wantBulk = !!selector && provider.supportsBulk;
	const wantRefs = refs.length > 0 && provider.supportsReferences;

	const bulkKey = wantBulk ? `${providerId}:${selector}` : null;
	const refKey = wantRefs ? refsKey(providerId, refs) : null;
	const now = Date.now();
	const bulkHit = bulkKey ? freshEntry(cache, bulkKey, now) : null;
	const refHit = refKey ? freshEntry(refsCache, refKey, now) : null;

	const bothCold = wantBulk && wantRefs && !bulkHit && !refHit;
	if (bothCold && provider.resolveCombined) {
		// Same single-flight guard as the split paths: without it two concurrent
		// probes would both read "cold" and open a session each, which is the cost
		// this path exists to remove.
		const combinedKey = `${bulkKey}|${refKey}`;
		const pending = combinedInflight.get(combinedKey);
		if (pending) return pending;

		const call = (async () => {
			const combined = await provider.resolveCombined!(config, selector, refs);
			const bulkKeys = Object.keys(combined.bulk);
			const resolvedRefs = [...combined.refs.keys()];
			const at = Date.now();
			cache.set(bulkKey!, { keys: bulkKeys, at });
			refsCache.set(refKey!, { keys: resolvedRefs, at });
			return { bulkKeys, resolvedRefs };
		})().finally(() => {
			combinedInflight.delete(combinedKey);
		});

		combinedInflight.set(combinedKey, call);
		return call;
	}

	return {
		bulkKeys: wantBulk
			? await probeBulkKeysCached(providerId, provider, config, selector!)
			: [],
		resolvedRefs: wantRefs ? await probeRefsCached(providerId, provider, config, refs) : []
	};
}

/** A cache entry that is still inside the TTL; stale entries are dropped on read. */
function freshEntry(map: Map<string, Entry>, key: string, now: number): Entry | null {
	const hit = map.get(key);
	if (!hit) return null;
	if (now - hit.at < TTL_MS) return hit;
	map.delete(key);
	return null;
}
