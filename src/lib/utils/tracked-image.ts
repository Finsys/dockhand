/** Preserve the update source when Docker's Config.Image is an immutable image ID. */
export const UPDATE_SOURCE_LABEL = 'dockhand.update.source';

function validRegistryReference(reference: string, registryReference: unknown): registryReference is string {
	const colon = reference.lastIndexOf(':');
	const repo = colon > reference.lastIndexOf('/') ? reference.slice(0, colon) : reference;
	return typeof registryReference === 'string' && registryReference.startsWith(repo + '@') &&
		/^sha256:[a-f0-9]{64}$/.test(registryReference.slice(repo.length + 1));
}

export function trackedImageReference(image: string, labels?: Record<string, string> | null): string {
	try {
		const source = JSON.parse(labels?.[UPDATE_SOURCE_LABEL] ?? 'null');
		// Ignore stale metadata after an explicit image change, including a manual digest pin.
		if (/^sha256:[a-f0-9]{64}$/.test(image) && source?.imageId === image &&
			typeof source.reference === 'string' && source.reference && !source.reference.includes('@')) {
			return source.reference;
		}
	} catch { /* Containers without Dockhand metadata use their configured image. */ }
	return image;
}

/** The approved manifest is pullable on other hosts; a local image ID is not. */
export function portableImageReference(image: string, labels?: Record<string, string> | null): string {
	const reference = trackedImageReference(image, labels);
	if (reference !== image) {
		const source = JSON.parse(labels![UPDATE_SOURCE_LABEL]);
		if (validRegistryReference(reference, source.registryReference)) return source.registryReference;
	}
	return image;
}

export function trackedImageLabels(labels: Record<string, string> | undefined, reference: string, imageId: string, registryReference?: string): Record<string, string> {
	if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('Invalid verified image ID');
	if (registryReference !== undefined && !validRegistryReference(reference, registryReference)) throw new Error('Invalid verified registry reference');
	return { ...labels, [UPDATE_SOURCE_LABEL]: JSON.stringify({ reference, imageId, registryReference }) };
}

/**
 * How an image reference pins what it runs.
 *
 * `repo@sha256:...` names one exact manifest and nothing else: the tag is absent, so there
 * is no moving target to follow. `repo:tag@sha256:...` names a TAG and records which
 * manifest was behind it, which is what a base image patched for a CVE looks like - the
 * tag stays, the digest moves. The two read alike and mean opposite things, so an update
 * check that treats both as pinned never reports the second one moving.
 */
export type ImagePinning = 'digest' | 'tag-with-digest' | 'tag';

export function imagePinning(image: string): ImagePinning {
	const at = image.lastIndexOf('@');
	if (at === -1) return 'tag';

	const name = image.slice(0, at);
	// A colon after the last slash is the tag; one before it is a registry port.
	const colon = name.lastIndexOf(':');
	return colon > name.lastIndexOf('/') ? 'tag-with-digest' : 'digest';
}

/** The tag half of a `repo:tag@sha256:...` reference, which is what an update follows. */
export function imageReferenceWithoutDigest(image: string): string {
	const at = image.lastIndexOf('@');
	return at === -1 ? image : image.slice(0, at);
}

/**
 * Whether a reference carries a digest at all - the gate the UPDATERS use. Detection
 * follows the tag of a `repo:tag@sha256:...`, but applying one is never ours: the pull
 * returns the manifest already pinned, so an update would mean rewriting the digest the
 * user put in their compose. Both digest-bearing shapes answer true, so neither reaches
 * a recreate.
 */
export function isDigestBasedImage(image: string): boolean {
	return image.includes('@sha256:');
}

/**
 * What an update check should do with a reference.
 *
 * `skip` - a digest with no tag names one manifest, so nothing can move.
 * `check` - ask the registry about `reference`, and when `pinned` is set report any move
 * without applying it, because pulling the original reference returns the manifest
 * already running.
 */
export interface ImageCheckPlan {
	skip: boolean;
	reference: string;
	pinned: boolean;
}

export function imageCheckPlan(image: string): ImageCheckPlan {
	const pinning = imagePinning(image);
	return {
		skip: pinning === 'digest',
		reference: imageReferenceWithoutDigest(image),
		pinned: pinning === 'tag-with-digest'
	};
}

/**
 * Whether the check should report a reference as pinned-with-a-moved-digest. True only
 * when the image pins a digest on its tag (`plan.pinned`) AND the tag's digest has
 * actually moved (`hasUpdate`). A pinned tag whose digest has not moved is just up to
 * date, so it carries no flag - keeping the pin marker and the update counters off a
 * quiet pin, and keeping the manual and scheduled checks in agreement.
 */
export function resolvePinnedToDigest(plan: ImageCheckPlan, hasUpdate: boolean | undefined): boolean {
	return plan.pinned && hasUpdate === true;
}
