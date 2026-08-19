/**
 * Decide whether a running image has a newer VERSION tag available. Glues the
 * registry tag list (I/O) to the pure version comparison, and short-circuits for
 * floating tags so `latest`/`stable`/sha never trigger a registry fetch.
 */
import { parseImageReference } from '../registry/image-ref';
import { parseTag } from './tag-parser';
import { listVersionTags } from './tag-source';
import { findNewerVersionTag, type FindNewerOptions, type NewerVersion } from './find-newer';

/**
 * Returns the newer-version suggestion for `imageRef`, or null when the current
 * tag isn't a version (floating) or nothing newer is published. Never throws —
 * a registry failure yields null, so the update check degrades gracefully.
 */
export async function checkNewerVersion(
	imageRef: string,
	options: FindNewerOptions = {}
): Promise<NewerVersion | null> {
	const { tag } = parseImageReference(imageRef);

	// Floating tag -> nothing to compare, and we skip the registry call entirely.
	// Parse with the same override find-newer will use, so a custom-scheme tag
	// isn't wrongly dismissed as floating before the registry fetch.
	if (!parseTag(tag, options.versionPattern ?? null)) return null;

	const tags = await listVersionTags(imageRef);
	return findNewerVersionTag(tag, tags, options);
}
