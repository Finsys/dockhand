// Pure helpers for image pruning. Kept dependency-free (no db / better-sqlite3)
// so they can be unit-tested directly, mirroring volume-prune-core.ts.

/**
 * Image label that opts an image out of an "all unused" prune. Tag an image
 * with `dockhand.prune=false` (e.g. `docker build --label dockhand.prune=false`)
 * and Docker's own prune skips it - no holder container needed.
 */
export const PRUNE_KEEP_LABEL = 'dockhand.prune=false';

/**
 * Build the `filters=` query value for a Docker `/images/prune` call.
 *
 * @param dangling true = only untagged images (keep-label does not apply, since
 *   dangling images have no labels of interest); false = all unused, and images
 *   carrying PRUNE_KEEP_LABEL are excluded.
 *
 * IMPORTANT: over the Docker ENGINE API the label negation is a SEPARATE filter
 * key `label!` (`{"label!":["dockhand.prune=false"]}`). The `label!=value` form
 * is the docker CLI surface and is a no-op over the API - verified against a
 * live daemon (both Docker 27 and 20.10 / API 1.41). A plain `label` key would
 * invert the meaning (prune ONLY matching images).
 */
export function buildImagePruneFilters(dangling: boolean): string {
	const filters: Record<string, string[]> = dangling
		? { dangling: ['true'] }
		: { dangling: ['false'], 'label!': [PRUNE_KEEP_LABEL] };
	return encodeURIComponent(JSON.stringify(filters));
}
