/**
 * How many images a Docker image prune removed, from its `ImagesDeleted` list. The
 * list has one `Untagged` entry per tag and several `Deleted` entries per image, so
 * tags are counted; a prune of untagged images untags by digest instead, and one that
 * only deleted is counted by its `Deleted` entries rather than reported as nothing.
 */
export function prunedImageCount(deleted: { Untagged?: string; Deleted?: string }[] | null | undefined): number {
	const entries = deleted ?? [];
	const untagged = entries.filter((e) => e.Untagged);
	const byTag = untagged.filter((e) => !e.Untagged!.includes('@sha256:')).length;
	if (byTag) return byTag;
	if (untagged.length) return untagged.length;
	return entries.filter((e) => e.Deleted).length;
}
