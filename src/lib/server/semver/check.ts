/**
 * Decide whether a running image has a newer VERSION tag available. Glues the
 * registry tag list (I/O) to the pure version comparison, and short-circuits for
 * floating tags so `latest`/`stable`/sha never trigger a registry fetch.
 */
import { parseImageReference } from '../registry/image-ref';
import { parseTag } from './tag-parser';
import { listVersionTags } from './tag-source';
import { findNewerVersionTag, findNewerImageTag, type FindNewerOptions, type NewerVersion } from './find-newer';
import type { ArtifactKind } from './manifest-artifact';

/** Probe a single tag's artifact kind + manifest digest. Injected so check.ts stays unit-testable. */
export type TagKindProbe = (
	registry: string,
	repo: string,
	tag: string
) => Promise<{ kind: ArtifactKind; digest: string | null }>;

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
	probeTagKind?: TagKindProbe
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
				const { kind, digest } = await probeTagKind(registry, repo, candidate);
				return { ok: kind === 'image', digest };
			} catch {
				return { ok: true }; // fail-open: never hide a real update on a probe error.
			}
		},
		options
	);
}
