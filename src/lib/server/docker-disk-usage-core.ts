export interface DockerDiskUsageLike {
	LayersSize?: unknown;
	ImageUsage?: {
		TotalSize?: unknown;
	} | null;
	Images?: Array<{
		Size?: unknown;
	}> | null;
}

function asNonNegativeFiniteNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0
		? value
		: null;
}

/**
 * Return Docker's aggregate image disk usage without double-counting shared layers.
 *
 * `Images[].Size` is each image's virtual size (shared + unique), so adding those
 * values overstates disk usage whenever images share layers. Docker exposes the
 * deduplicated total as `ImageUsage.TotalSize` in the current API and as
 * `LayersSize` in the legacy response shape.
 */
export function getImageDiskUsageTotalSize(
	diskUsage: DockerDiskUsageLike | null | undefined
): number | null {
	const currentTotal = asNonNegativeFiniteNumber(diskUsage?.ImageUsage?.TotalSize);
	if (currentTotal !== null) return currentTotal;

	return asNonNegativeFiniteNumber(diskUsage?.LayersSize);
}
