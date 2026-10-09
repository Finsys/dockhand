/**
 * Collecting one environment's contribution to a state report.
 *
 * Separate from the route because the scheduled mail builds the same report: two copies of
 * this would drift, and a report that differs depending on how it was asked for is worse
 * than no report.
 */

import { getAuditLogs } from './db';
import { countFindingsByImage, listScannedImageNames } from './vuln-summary';
import { listContainers } from './docker';
import type { ReportEnvironment } from './environment-report-core';

/**
 * Everything one environment contributes to a report.
 *
 * The containers are listed ONCE and everything else is derived from them: the
 * stacks from the compose project label, and the vulnerability counts from the
 * image ids, counted in the database. Reading the scan rows instead would parse
 * every findings document for six integers, and would count an image twice when
 * both scanners are enabled.
 */
export async function collectEnvironment(
	id: number | null,
	name: string,
	withChanges: boolean
): Promise<ReportEnvironment> {
	let containers;
	try {
		containers = await listContainers(true, id);
	} catch (error) {
		// A report that silently shows an unreachable environment as empty would
		// read as "nothing deployed, nothing vulnerable" to whoever relies on it.
		return {
			id,
			name,
			unreachable: true,
			unreachableReason: error instanceof Error ? error.message : String(error),
			containers: [],
			stacks: [],
			scans: []
		};
	}

	const reportContainers = containers.map((c) => ({
		name: c.name,
		image: c.image,
		status: c.state || c.status || '',
		// Compose stamps the project on every container it manages.
		stack: c.labels?.['com.docker.compose.project'] ?? null
	}));

	const stacks = [
		...new Set(reportContainers.map((c) => c.stack).filter((s): s is string => !!s))
	].sort();

	const env: ReportEnvironment = { id, name, containers: reportContainers, stacks, scans: [] };

	// Counts come from the database for the images the host actually has, so an
	// image scanned by both grype and trivy is still one image with one set of counts.
	const liveImageIds = [...new Set(containers.map((c) => c.imageId).filter(Boolean))];
	if (id !== null && liveImageIds.length > 0) {
		const [byImage, names] = await Promise.all([
			countFindingsByImage(id, liveImageIds).catch(() => null),
			listScannedImageNames(id, liveImageIds).catch(() => [])
		]);
		if (byImage && names.length > 0) {
			// Counted per image, because the point of this table is which image is
			// vulnerable. An image with no findings is absent from the map and is a
			// scanned, clean image - not an unscanned one.
			env.scans = names.map((n) => {
				const c = byImage.get(n.imageId);
				return {
					image: n.imageName,
					critical: c?.critical ?? 0,
					high: c?.high ?? 0,
					medium: c?.medium ?? 0,
					low: c?.low ?? 0,
					scannedAt: null
				};
			});
		}
	}

	if (withChanges && id !== null) {
		const logs = await getAuditLogs({ environmentId: id, limit: 500 }).catch(() => null);
		env.changes = (logs?.logs ?? []).map((l) => ({
			at: l.createdAt,
			username: l.username ?? '',
			action: l.action,
			entityType: l.entityType,
			entityName: l.entityName ?? ''
		}));
	}

	return env;
}
