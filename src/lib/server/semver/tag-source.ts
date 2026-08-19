/**
 * List every version-looking tag an image's registry publishes, so the pure
 * `findNewerVersionTag` can pick the newest. Routes to the right fetch strategy
 * by host (Docker Hub API vs generic Registry v2), and caches per repo for 6h —
 * the set of published tags changes slowly and this keeps registries un-hammered.
 *
 * GHCR note: ghcr.io works through the generic v2 path here. GitHub's Packages
 * API returns versions newest-first (nicer for repos buried under git-hash tags),
 * but it needs a token we don't yet store — a phase-2 optimization, not a gap.
 */
import { parseImageReference, isDockerHub } from '../registry/image-ref';
import { findRegistryCredentials } from '../docker';
import { fetchDockerHubTags } from './strategies/docker-hub';
import { fetchGenericV2Tags } from './strategies/generic-v2';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface CacheEntry {
	tags: string[];
	expiresAt: number;
}
// Keyed by `registry/repo`. Registry credentials are stored per-HOST (not per
// environment) in Dockhand's registries table, so the tag list for a given
// registry/repo is the same regardless of which env asked - the key needs no env
// dimension. A generic V2 registry that needs auth uses the stored credentials
// for that host (same lookup the digest check uses); an unauthenticated repo just
// works anonymously.
const cache = new Map<string, CacheEntry>();
// In-flight fetches keyed the same way, so a burst of same-image containers in
// one check pass (CONCURRENCY=20) collapses to ONE registry request per repo
// instead of one per container.
const inflight = new Map<string, Promise<string[]>>();

/**
 * All tags published for the image behind `imageRef`, cached per repo. Returns
 * `[]` on any registry failure — the caller treats "no tags" as "nothing newer".
 */
export async function listVersionTags(imageRef: string): Promise<string[]> {
	const { registry, repo } = parseImageReference(imageRef);
	const cacheKey = `${registry}/${repo}`;

	const cached = cache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) return cached.tags;

	const pending = inflight.get(cacheKey);
	if (pending) return pending;

	const promise = (async () => {
		let tags: string[] = [];
		try {
			if (isDockerHub(registry)) {
				tags = await fetchDockerHubTags(repo);
			} else {
				const credentials = await findRegistryCredentials(registry).catch(() => null);
				tags = await fetchGenericV2Tags(registry, repo, credentials);
			}
		} catch {
			tags = [];
		}
		cache.set(cacheKey, { tags, expiresAt: Date.now() + CACHE_TTL_MS });
		return tags;
	})();

	inflight.set(cacheKey, promise);
	try {
		return await promise;
	} finally {
		inflight.delete(cacheKey);
	}
}

/** Test-only: clear the per-repo tag cache. */
export function __resetTagSourceCacheForTests(): void {
	cache.clear();
	inflight.clear();
}
