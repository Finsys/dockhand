/**
 * Build a digest-pinned image reference from a `repo:tag` and the image's
 * RepoDigests, for the "copy pinned reference" action. A supply-chain-hardened
 * reference keeps the human-readable tag AND pins the immutable digest:
 *
 *   nginx:1.25  +  ["nginx@sha256:abc..."]  ->  nginx:1.25@sha256:abc...
 *
 * Pure, no I/O - unit-tested. Returns null when no digest matches the repo (an
 * image built locally and never pushed has no RepoDigests), so the caller can
 * hide/disable the button instead of copying a broken ref.
 */

/** Split `repo:tag` (or a bare `repo`) into its repo and tag parts. A colon that
 *  is part of a registry `host:port` is not a tag separator. A digest suffix
 *  (`@sha256:...`) is stripped first so its colon is never mistaken for the tag. */
function splitRepoTag(fullRef: string): { repo: string; tag: string | null } {
	const ref = stripDigest(fullRef);
	const lastColon = ref.lastIndexOf(':');
	if (lastColon === -1) return { repo: ref, tag: null };
	// A tag never contains a slash; `host:port/repo` has the slash AFTER the colon.
	if (ref.slice(lastColon + 1).includes('/')) return { repo: ref, tag: null };
	return { repo: ref.slice(0, lastColon), tag: ref.slice(lastColon + 1) };
}

/** Drop a `@sha256:...` (or any `@digest`) suffix from an image reference. */
function stripDigest(ref: string): string {
	const at = ref.indexOf('@');
	return at === -1 ? ref : ref.slice(0, at);
}

/**
 * The repo part of a running image reference, WITHOUT its tag or digest.
 * `ghcr.io/o/app:1.2@sha256:abc` -> `ghcr.io/o/app`, `nginx:1.25` -> `nginx`.
 * A digest-pinned running image is why the naive "cut at the last colon"
 * approach breaks: that colon lives inside `@sha256:` (#1437).
 */
export function repoBaseOf(image: string): string {
	return splitRepoTag(image).repo;
}

/** The `sha256:...` part of a `repo@sha256:...` digest, or null. */
function digestOf(repoDigest: string): string | null {
	const at = repoDigest.indexOf('@');
	return at > 0 ? repoDigest.slice(at + 1) : null;
}

/**
 * Return `repo:tag@sha256:...` for `fullRef`, picking the digest whose repo
 * matches. Falls back to the single available digest when there is exactly one
 * (common case: one repo, one digest). Returns null if no usable digest exists.
 */
export function buildPinnedRef(fullRef: string, repoDigests: string[] | undefined | null): string | null {
	if (!repoDigests || repoDigests.length === 0) return null;
	const { repo, tag } = splitRepoTag(fullRef);

	// Prefer the digest published for the SAME repo as this tag (an image can carry
	// digests for several repo names when it was tagged/pushed under more than one).
	const match =
		repoDigests.find((d) => d.slice(0, d.indexOf('@')) === repo) ??
		(repoDigests.length === 1 ? repoDigests[0] : null);
	if (!match) return null;

	const digest = digestOf(match);
	if (!digest) return null;

	return tag ? `${repo}:${tag}@${digest}` : `${repo}@${digest}`;
}

/**
 * The manifest digest (`sha256:...`) for `fullRef`, shortened for display, or null.
 * Same matching rules as buildPinnedRef. `chars` counts hex digits shown after the
 * `sha256:` prefix.
 */
export function shortDigest(
	fullRef: string,
	repoDigests: string[] | undefined | null,
	chars = 12
): string | null {
	const pinned = buildPinnedRef(fullRef, repoDigests);
	if (!pinned) return null;
	const at = pinned.lastIndexOf('@');
	const digest = pinned.slice(at + 1); // sha256:....
	const colon = digest.indexOf(':');
	if (colon === -1) return digest.slice(0, chars);
	return `${digest.slice(0, colon + 1)}${digest.slice(colon + 1, colon + 1 + chars)}`;
}
