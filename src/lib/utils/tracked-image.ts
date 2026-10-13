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
