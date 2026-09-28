/** Preserve the update source when Docker's Config.Image is an immutable image ID. */
export const UPDATE_SOURCE_LABEL = 'dockhand.update.source';

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

export function trackedImageLabels(labels: Record<string, string> | undefined, reference: string, imageId: string): Record<string, string> {
	if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('Invalid verified image ID');
	return { ...labels, [UPDATE_SOURCE_LABEL]: JSON.stringify({ reference, imageId }) };
}
