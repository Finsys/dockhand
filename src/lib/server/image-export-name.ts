/**
 * Naming an exported image file.
 *
 * An image is addressed by id on the export route, because a name like
 * "repo/image:tag" is decoded before the route is matched and its slash splits the
 * path into a segment too many. The id says nothing about which tag the person
 * clicked, so the tag travels separately and is checked against the image before it
 * is believed.
 */

/** The download filename stem for an image, without extension. */
export function exportFileStem(
	imageId: string,
	repoTags: string[] | undefined | null,
	requestedTag: string | null | undefined
): string {
	const tags = repoTags ?? [];

	// Only a tag the image actually carries: the value arrives in a query parameter,
	// and it ends up in a Content-Disposition filename.
	const tag = requestedTag && tags.includes(requestedTag) ? requestedTag : tags[0];

	// ":" and "/" are legal in a tag and awkward in a filename.
	if (tag) return tag.replace(/[:/]/g, '_');

	return shortId(imageId);
}

/**
 * What to ask the daemon to export.
 *
 * A tar saved by image id records `RepoTags: null`, so loading it back produces an
 * unnamed image. Saving by tag keeps the name in the archive. Only a tag the image
 * actually carries is used - the value reaches the daemon, and the id is the safe
 * fallback for an image that has no tags at all.
 */
export function exportRefFor(
	imageId: string,
	repoTags: string[] | undefined | null,
	requestedTag: string | null | undefined
): string {
	const tags = repoTags ?? [];
	if (requestedTag && tags.includes(requestedTag)) return requestedTag;
	return tags[0] ?? imageId;
}

/** An untagged image is named after the front of its digest, as docker shows it. */
export function shortId(imageId: string): string {
	return imageId.replace('sha256:', '').slice(0, 12);
}
