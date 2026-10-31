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
 * Which image a candidate's manifest digest holds for the daemon's platform (its
 * config digest, i.e. the image ID) and when it was built. Returning null (unknown)
 * keeps the candidate, so a registry that will not answer never hides a real update.
 */
export type ImageIdentityProbe = (
	registry: string,
	repo: string,
	digest: string
) => Promise<{ configDigest: string; createdAt: string | null } | null>;

/**
 * The running image, as the candidate probe compares against it. `currentCreatedAt`
 * is set only when "ignore tags older than what you run" is on; without it a
 * candidate's date only orders the candidates.
 */
export interface RunningImageCheck {
	probeImage: ImageIdentityProbe;
	currentImageId: string;
	currentCreatedAt?: string | null;
}

/**
 * Returns the newer-version suggestion for `imageRef`, or null when the current
 * tag isn't a version (floating) or nothing newer is published. Never throws —
 * a registry failure yields null, so the update check degrades gracefully.
 *
 * When `probeTagKind` is supplied, each candidate is verified to be a real
 * container image, not a Helm chart / other OCI artifact published into the same
 * repo (monorepos do this). A non-image target is dropped and the next-highest
 * version is tried. A probe failure is treated as "is an image" (fail-open) so a
 * registry hiccup never hides a real update.
 *
 * `runningImage` adds the image-level look: a candidate holding the image already
 * running is redundant whatever its manifest digest, and the candidates are ordered
 * by build date (see findNewerImageTag).
 *
 * `listedAfter` makes the tag list fresh: a cached list is reused only if its listing
 * started at or after that time (a manual check passes its own start).
 */
export async function checkNewerVersion(
	imageRef: string,
	options: FindNewerOptions = {},
	probeTagKind?: TagKindProbe,
	currentImageDigests: readonly (string | null | undefined)[] = [],
	runningImage?: RunningImageCheck,
	listedAfter?: number
): Promise<NewerVersion | null> {
	const { registry, repo, tag } = parseImageReference(imageRef);

	// Floating tag -> nothing to compare, and we skip the registry call entirely.
	// Parse with the same override find-newer will use, so a custom-scheme tag
	// isn't wrongly dismissed as floating before the registry fetch.
	if (!parseTag(tag, options.versionPattern ?? null)) return null;

	const tags = await listVersionTags(imageRef, listedAfter);

	if (!probeTagKind) return findNewerVersionTag(tag, tags, options);

	// On the containerd image store the image ID is the manifest digest, so it is
	// one more digest the running image answers to.
	const runningDigests = runningImage ? [...currentImageDigests, runningImage.currentImageId] : currentImageDigests;

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
				if (isRedundantNewerVersion(digest, runningDigests, childDigests)) return { ok: false, redundant: true };
				if (kind !== 'image') return { ok: false };
				if (!runningImage || !digest) return { ok: true, digest };
				const image = await runningImage.probeImage(registry, repo, digest).catch(() => null);
				// The same image under another index: another arch rebuilt, attestations
				// re-pushed, a re-tag. No manifest digest can tell; the config digest can.
				if (image && runningDigests.includes(image.configDigest)) return { ok: false, redundant: true };
				// A tag whose image predates the running one is not an upgrade, whatever
				// its name sorts to. Excluded rather than final, so a genuinely newer
				// version lower down the list is still found.
				if (isStaleCandidate(image?.createdAt, runningImage.currentCreatedAt)) return { ok: false };
				return { ok: true, digest, createdAt: image?.createdAt, imageId: image?.configDigest };
			} catch {
				return { ok: true }; // fail-open: never hide a real update on a probe error.
			}
		},
		options
	);
}
