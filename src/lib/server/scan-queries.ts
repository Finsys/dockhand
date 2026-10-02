import { db, vulnerabilityScans, eq, desc, isNull, sql } from './db/drizzle.js';
import type { VulnerabilityScanData } from './db';

/**
 * The newest scan per image and scanner. `undefined` reads every environment,
 * `null` the local one, a number that environment.
 *
 * Every scan keeps its whole findings document, so the superseded rows are
 * dropped by the database rather than read and discarded here.
 */
export async function getAllLatestScans(
	environmentId?: number | null
): Promise<VulnerabilityScanData[]> {
	const envFilter =
		environmentId === undefined
			? undefined
			: environmentId === null
				? isNull(vulnerabilityScans.environmentId)
				: eq(vulnerabilityScans.environmentId, environmentId);

	// The ranking and the filter stay in ONE statement: reading the ids out and
	// passing them back would bind a parameter per row, and the driver's variable
	// limit (32766 on SQLite) would turn a large history into a query error.
	// `id desc` breaks a tie on scanned_at, so which row wins is deterministic.
	const ranked = db
		.select({
			id: vulnerabilityScans.id,
			rn: sql<number>`row_number() over (
				partition by ${vulnerabilityScans.imageId}, ${vulnerabilityScans.scanner}
				order by ${vulnerabilityScans.scannedAt} desc, ${vulnerabilityScans.id} desc
			)`.as('dockhand_rn')
		})
		.from(vulnerabilityScans)
		.where(envFilter)
		.as('ranked');

	const rows = await db
		.select({ scan: vulnerabilityScans })
		.from(vulnerabilityScans)
		.innerJoin(ranked, eq(vulnerabilityScans.id, ranked.id))
		.where(eq(ranked.rn, 1))
		.orderBy(desc(vulnerabilityScans.scannedAt));

	return rows.map(({ scan }: { scan: Record<string, unknown> }) => ({
		...scan,
		vulnerabilities: scan.vulnerabilities ? JSON.parse(scan.vulnerabilities as string) : []
	})) as VulnerabilityScanData[];
}

/**
 * The distinct image ids that have a scan in this environment.
 *
 * Just the ids: the caller intersects them with the live Docker image list, and
 * reading the findings documents to learn which images were scanned is what
 * made that cost hundreds of megabytes.
 */
export async function getScannedImageIds(environmentId?: number | null): Promise<string[]> {
	const envFilter =
		environmentId === undefined
			? undefined
			: environmentId === null
				? isNull(vulnerabilityScans.environmentId)
				: eq(vulnerabilityScans.environmentId, environmentId);

	const rows: { imageId: string }[] = await db
		.selectDistinct({ imageId: vulnerabilityScans.imageId })
		.from(vulnerabilityScans)
		.where(envFilter);

	return rows.map((r) => r.imageId);
}
