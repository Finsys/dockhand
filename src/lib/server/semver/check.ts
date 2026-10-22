/**
 * Decide whether a running image has a newer VERSION tag available. Glues the
 * registry tag list (I/O) to the pure version comparison, and short-circuits for
 * floating tags so `latest`/`stable`/sha never trigger a registry fetch.
 */
import { parseImageReference } from '../registry/image-ref';
import { parseTag } from './tag-parser';
import { listVersionTags } from './tag-source';
import { findNewerVersionTag, findNewerImageTag, isRedundantNewerVersion, isStaleCandidate, type FindNewerOptions, type NewerVersion } from './find-newer';
import type { ArtifactKind } from './manifest-artifact';

/** Probe a single tag's artifact kind + manifest digest. Injected so check.ts stays unit-testable. */
export type TagKindProbe = (
	registry: string,
	repo: string,
	tag: string
) => Promise<{ kind: ArtifactKind; digest: string | null; childDigests?: string[] }>;

/**
 * When the candidate's build date is wanted, the caller supplies this and the
 * running image's own date. Returning null (unknown) keeps the candidate, so a
 * registry that will not answer never hides a real update.
 */
export type ImageCreatedAtProbe = (
	registry: string,
	repo: string,
	digest: string
) => Promise<string | null>;

/**
 * Returns the newer-version suggestion for `imageRef`, or null when the current
 * tag isn't a version (floating) or nothing newer is published. Never throws —
 * a registry failure yields null, so the update check degrades gracefully.
 *
 * When `probeTagKind` is supplied, the chosen candidate is verified to be a real
 * container image, not a Helm chart / other OCI artifact published into the same
 * repo (monorepos do this). A non-image target is dropped and the next-highest
 * version is tried. Only the candidate is probed. A probe failure is treated as
 * "is an image" (fail-open) so a registry hiccup never hides a real update.
 */
export async function checkNewerVersion(
	imageRef: string,
	options: FindNewerOptions = {},
	probeTagKind?: TagKindProbe,
	currentImageDigests: readonly (string | null | undefined)[] = [],
	staleCheck?: { probeCreatedAt: ImageCreatedAtProbe; currentCreatedAt: string | null }
): Promise<NewerVersion | null> {
	const { registry, repo, tag } = parseImageReference(imageRef);

	// Floating tag -> nothing to compare, and we skip the registry call entirely.
	// Parse with the same override find-newer will use, so a custom-scheme tag
	// isn't wrongly dismissed as floating before the registry fetch.
	if (!parseTag(tag, options.versionPattern ?? null)) return null;

	const tags = await listVersionTags(imageRef);

	if (!probeTagKind) return findNewerVersionTag(tag, tags, options);

	return findNewerImageTag(
		tag,
		tags,
		async (candidate) => {
			try {
				const { kind, digest, childDigests } = await probeTagKind(registry, repo, candidate);
				// A more specific tag (12.3.3) that resolves to the SAME image the
				// running container already has is not a real update - and nothing higher
				// exists, so stop rather than drop to a lower patch (#1572). Matches the
				// index digest or a per-arch child digest (RepoDigests can hold either).
				if (isRedundantNewerVersion(digest, currentImageDigests, childDigests)) return { ok: false, redundant: true };
				if (kind !== 'image') return { ok: false };
				// A tag whose image predates the running one is not an upgrade, whatever
				// its name sorts to. Excluded rather than final, so a genuinely newer
				// version lower down the list is still found.
				if (staleCheck && digest) {
					const candidateCreatedAt = await staleCheck.probeCreatedAt(registry, repo, digest).catch(() => null);
					if (isStaleCandidate(candidateCreatedAt, staleCheck.currentCreatedAt)) return { ok: false };
				}
				return { ok: true, digest };
			} catch {
				return { ok: true }; // fail-open: never hide a real update on a probe error.
			}
		},
		options
	);
}
