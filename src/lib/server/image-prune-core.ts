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

/**
 * `filters=` for listing images by the keep label: `negate` lists those without it.
 */
export function buildKeepLabelFilter(negate: boolean): string {
	return encodeURIComponent(JSON.stringify({ [negate ? 'label!' : 'label']: [PRUNE_KEEP_LABEL] }));
}

/**
 * Docker 29.0 - 29.4.0 with the containerd image store matches no image at all for
 * a `label!` filter (moby#52338, fixed in 29.4.1), so a prune of all unused images
 * removes nothing. Listing images with and without that filter tells: images exist,
 * yet none lacks the keep label. When every image carries it the answer is also
 * true, which is harmless: the image-by-image prune keeps them all the same.
 */
export function labelNegationBroken(allImages: number, withoutKeepLabel: number): boolean {
	return allImages > 0 && withoutKeepLabel === 0;
}

export interface PruneImageSummary {
	Id: string;
	RepoTags?: string[] | null;
}

/**
 * What a prune of all unused images removes, as the references to delete one image
 * at a time: every image no container uses (stopped ones included) and none with the
 * keep label. A tagged image goes tag by tag - deleting by id refuses an image with
 * several tags - and the last tag removes it; an untagged one goes by id.
 */
export function imageRefsToRemove(
	images: PruneImageSummary[],
	keptIds: Set<string>,
	usedIds: Set<string>
): string[][] {
	return images
		.filter((img) => !keptIds.has(img.Id) && !usedIds.has(img.Id))
		.map((img) => {
			const tags = (img.RepoTags ?? []).filter((t) => t !== '<none>:<none>');
			return tags.length ? tags : [img.Id];
		});
}

export interface ImageDeleteEntry {
	Untagged?: string;
	Deleted?: string;
}

/** A prune result. `SpaceReclaimed` is left out when it is not known. */
export interface ImagePruneResult {
	ImagesDeleted: ImageDeleteEntry[] | null;
	SpaceReclaimed?: number;
}

export interface ImagePrunePorts {
	listImages(filters?: string): Promise<PruneImageSummary[]>;
	listContainers(): Promise<{ ImageID: string }[]>;
	prune(): Promise<ImagePruneResult>;
	remove(ref: string): Promise<ImageDeleteEntry[]>;
	log(message: string): void;
}

/**
 * Prune all unused images except those with the keep label. Where the engine's
 * `label!` filter is broken (see labelNegationBroken) Docker's prune would remove
 * nothing, so the images go one by one instead; Docker still refuses any a container
 * uses. That path cannot say how much space it freed, so it reports only the images.
 */
export async function pruneAllUnused(docker: ImagePrunePorts): Promise<ImagePruneResult> {
	const all = await docker.listImages();
	let withoutKept: PruneImageSummary[];
	try {
		withoutKept = await docker.listImages(buildKeepLabelFilter(true));
	} catch (err) {
		// Older engines (Docker 20.10) refuse `label!` on the image list but honour it in prune.
		docker.log(`label! image listing refused (${err instanceof Error ? err.message : err}); using the ordinary prune`);
		return docker.prune();
	}
	if (!labelNegationBroken(all.length, withoutKept.length)) return docker.prune();

	docker.log('label! filter matches no image; removing unused images one by one');
	const kept = await docker.listImages(buildKeepLabelFilter(false));
	const containers = await docker.listContainers();
	const deleted: ImageDeleteEntry[] = [];
	for (const refs of imageRefsToRemove(all, new Set(kept.map((i) => i.Id)), new Set(containers.map((c) => c.ImageID)))) {
		for (const ref of refs) {
			try {
				deleted.push(...await docker.remove(ref));
			} catch (err) {
				// In use since the listing, or a parent of another image: Docker's refusal keeps it.
				docker.log(`Kept image "${ref}": ${err instanceof Error ? err.message : err}`);
				break;
			}
		}
	}
	return { ImagesDeleted: deleted.length ? deleted : null };
}
