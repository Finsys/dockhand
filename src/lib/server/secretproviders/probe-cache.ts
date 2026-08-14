/**
 * Short-lived cache for live provider probes.
 *
 * The stack editor probes the bound provider on every debounced keystroke to
 * classify a compose ${VAR} as present ("IN VAULT") or missing. Without a cache
 * a fast typist would hammer the provider's API. This caches ONLY the KEY NAMES
 * of a bulk selector for a few seconds - never the secret values.
 */

import type { SecretProvider, SecretProviderConfig } from './shared';

const TTL_MS = 30_000;

interface Entry {
	keys: string[];
	at: number;
}

// Keyed by `${providerId}:${selector}`. Bounded by (provider count * distinct
// selectors seen in the TTL window); stale entries are dropped lazily on read.
const cache = new Map<string, Entry>();

/**
 * Returns the KEY NAMES available under a provider's bulk selector, cached for
 * ~30s per (providerId, selector). Values are discarded immediately - only the
 * names are stored and returned. Propagates the provider's errors to the caller.
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
	if (hit && now - hit.at < TTL_MS) {
		return hit.keys;
	}
	const bulk = await provider.resolveBulk(config, selector);
	const keys = Object.keys(bulk);
	cache.set(cacheKey, { keys, at: now });
	return keys;
}
