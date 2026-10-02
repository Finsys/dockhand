import { db, isPostgres, sql, vulnerabilityScans, eq, inArray, and } from './db/drizzle.js';
import {
	EMPTY_COUNTS, readSummaryRow, summaryFragments, type SummaryCounts
} from './vuln-summary-core';

export type { SummaryCounts };
export { EMPTY_COUNTS };

/**
 * Severity counts for an environment's newest scans, restricted to the images
 * the host still has.
 *
 * The header needs six numbers, not the findings themselves, so they are
 * counted in the database rather than by reading every scan's findings document
 * into memory. `liveImageIds` comes from the live Docker state; an environment
 * whose scanned images are all gone has nothing to count.
 */
export async function countFindings(
	envIdNum: number,
	liveImageIds: string[]
): Promise<SummaryCounts> {
	if (liveImageIds.length === 0) return { ...EMPTY_COUNTS };

	const { head, mid, tail } = summaryFragments(isPostgres);
	const images = sql.join(liveImageIds.map((id) => sql`${id}`), sql`, `);

	const statement = sql`${sql.raw(head)}${envIdNum}${sql.raw(mid)}${images}${sql.raw(tail)}`;

	// The two drivers expose different raw-query methods and return different
	// shapes: postgres answers `execute` with the rows themselves or wrapped in
	// `rows`, sqlite answers `all` with the array.
	const result: unknown = isPostgres
		? await (db as { execute: (q: typeof statement) => Promise<unknown> }).execute(statement)
		: await (db as { all: (q: typeof statement) => Promise<unknown> }).all(statement);

	// `images` from the statement counts images that HAVE findings; the header
	// reports how many were SCANNED, and a clean image is still a scanned one.
	return { ...readSummaryRow(firstRow(result)), images: liveImageIds.length };
}

/**
 * The image names carrying findings, for the filter dropdown.
 *
 * Read from the scan rows rather than from the findings, so opening the page
 * does not have to parse a single findings document.
 */
export async function listScannedImageNames(
	envIdNum: number,
	liveImageIds: string[]
): Promise<{ imageId: string; imageName: string }[]> {
	if (liveImageIds.length === 0) return [];

	// Paired with the id so the caller can substitute the name the host uses now:
	// a scan records whatever the image was called when it ran.
	return (await db
		.selectDistinct({
			imageId: vulnerabilityScans.imageId,
			imageName: vulnerabilityScans.imageName
		})
		.from(vulnerabilityScans)
		.where(
			and(
				eq(vulnerabilityScans.environmentId, envIdNum),
				inArray(vulnerabilityScans.imageId, liveImageIds)
			)
		)) as { imageId: string; imageName: string }[];
}

/** The first row of a driver result, whichever shape that driver returns. */
function firstRow(result: unknown): Record<string, unknown> | undefined {
	if (Array.isArray(result)) return result[0];
	const rows = (result as { rows?: unknown })?.rows;
	return Array.isArray(rows) ? rows[0] : undefined;
}
