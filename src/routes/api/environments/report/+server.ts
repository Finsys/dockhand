import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { getEnvironments, getAuditLogs } from '$lib/server/db';
import { countFindings, listScannedImageNames } from '$lib/server/vuln-summary';
import { listContainers } from '$lib/server/docker';
import {
	buildReport,
	includeChanges,
	reportFilename,
	reportToCSV,
	type ReportEnvironment,
	type ReportTier
} from '$lib/server/environment-report-core';

/** A validated licence type as a report tier; null when no paid licence validates. */
function reportTier(licenseTier: string | null): ReportTier | null {
	if (licenseTier === 'enterprise') return 'enterprise';
	if (licenseTier === 'smb') return 'smb';
	return null;
}

/**
 * Everything one environment contributes to a report.
 *
 * The containers are listed ONCE and everything else is derived from them: the
 * stacks from the compose project label, and the vulnerability counts from the
 * image ids, counted in the database. Reading the scan rows instead would parse
 * every findings document for six integers, and would count an image twice when
 * both scanners are enabled.
 */
async function collectEnvironment(
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
		const [counts, names] = await Promise.all([
			countFindings(id, liveImageIds).catch(() => null),
			listScannedImageNames(id, liveImageIds).catch(() => [])
		]);
		if (counts && names.length > 0) {
			// One synthetic row carries the environment's counts: they are counted
			// across the environment, not per image, so splitting them would invent
			// a per-image breakdown the query never produced.
			env.scans = names.map((n, i) => ({
				image: n.imageName,
				critical: i === 0 ? counts.critical : 0,
				high: i === 0 ? counts.high : 0,
				medium: i === 0 ? counts.medium : 0,
				low: i === 0 ? counts.low : 0,
				scannedAt: null
			}));
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

/**
 * @openapi
 * summary: Export an environment state report as a downloadable file
 * description: Inventory, vulnerability counts and scan coverage for one environment or for every environment the caller may see. Requires a valid paid license of either tier. The change history is included only for an enterprise license, because it is the audit log under another name.
 * query: env:integer One environment id; omit to report on every accessible environment
 * query: format:string Output format - json (default) or csv
 * resp-200: The report as a downloadable json or csv attachment
 * resp-400: The env query parameter is not a number
 * resp-401: Authentication required
 * resp-403: A paid license is required, or permission denied
 * resp-404: No accessible environment matches the requested id
 * resp-500: Failed to build the report
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	if (auth.authEnabled && !auth.isAuthenticated) {
		return json({ error: 'Authentication required' }, { status: 401 });
	}

	const tier = reportTier(auth.licenseTier);
	if (!tier) {
		return json({ error: 'A commercial license is required' }, { status: 403 });
	}

	if (!(await auth.can('environments', 'view'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const envParam = url.searchParams.get('env');
		const all = await getEnvironments();
		const accessible = await auth.getAccessibleEnvironmentIds();

		let selected = accessible === null ? all : all.filter((e) => accessible.includes(e.id));

		if (envParam !== null && envParam !== '') {
			const wanted = parseInt(envParam, 10);
			if (!Number.isFinite(wanted)) {
				return json({ error: 'Invalid environment id' }, { status: 400 });
			}
			selected = selected.filter((e) => e.id === wanted);
			if (selected.length === 0) {
				return json({ error: 'Environment not found' }, { status: 404 });
			}
		}

		// The change history is the audit log, so it answers to the audit permission
		// as well as the tier. A caller without it still gets the report, minus that
		// section, rather than being refused the export outright.
		const withChanges = includeChanges(tier) && (await auth.canViewAuditLog());
		const environments = await Promise.all(
			selected.map((e) => collectEnvironment(e.id, e.name, withChanges))
		);

		const generatedAt = new Date().toISOString();
		const report = buildReport(environments, withChanges, {
			generatedAt,
			appVersion: __APP_VERSION__ ?? 'unknown'
		});

		const format = (url.searchParams.get('format') || 'json').toLowerCase();
		const scope = selected.length === 1 ? selected[0].name : 'all-environments';
		const filename = reportFilename(scope, generatedAt, format === 'csv' ? 'csv' : 'json');
		const body = format === 'csv' ? reportToCSV(report) : JSON.stringify(report, null, 2);

		return new Response(body, {
			headers: {
				'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json',
				'Content-Disposition': `attachment; filename="${filename}"`
			}
		});
	} catch (error) {
		console.error('Error building environment report:', error);
		return json({ error: 'Failed to build the report' }, { status: 500 });
	}
};
