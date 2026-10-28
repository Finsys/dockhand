/**
 * List every version-looking tag an image's registry publishes, so the pure
 * `findNewerVersionTag` can pick the newest. Routes to the right fetch strategy
 * by host (Docker Hub API vs generic Registry v2), and caches each listing: 1 h for a
 * complete list, 10 min for a partial or failed one (tag-source-core.ts).
 *
 * GHCR note: ghcr.io works through the generic v2 path here. GitHub's Packages
 * API returns versions newest-first (nicer for repos buried under git-hash tags),
 * but it needs a token we don't yet store — a phase-2 optimization, not a gap.
 */
import { parseImageReference, isDockerHub } from '../registry/image-ref';
import { findRegistryCredentials } from '../docker';
import { fetchDockerHubTags } from './strategies/docker-hub';
import { fetchGenericV2Tags, fetchGenericV2TagsAfter } from './strategies/generic-v2';
import { createTagCache, tagListings } from './tag-source-core';

const tagCache = createTagCache();

/**
 * The tags an image's registry publishes that newer-version detection can read, from
 * the listings `tagListings` picks, each cached on its own. A partial listing returns the
 * tags it read; a failed one returns [], which the caller treats as nothing newer.
 */
export async function listVersionTags(imageRef: string, listedAfter?: number): Promise<string[]> {
	const { registry, repo, tag } = parseImageReference(imageRef);
	const dockerHub = isDockerHub(registry);
	const lists = await Promise.all(tagListings(registry, repo, tag, dockerHub).map(({ key, after }) =>
		tagCache.get(key, async () => {
			if (dockerHub) return fetchDockerHubTags(repo);
			const credentials = await findRegistryCredentials(registry, repo).catch(() => null);
			return after ? fetchGenericV2TagsAfter(registry, repo, credentials, after) : fetchGenericV2Tags(registry, repo, credentials);
		}, listedAfter)
	));
	return lists.length === 1 ? lists[0] : [...new Set(lists.flat())];
}

/** Test-only: clear the tag cache. */
export function __resetTagSourceCacheForTests(): void {
	tagCache.clear();
}
