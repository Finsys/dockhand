import { getFilteredSortedFindings, getVulnerabilitiesMeta, parseVulnerabilitiesQuery, type Finding } from '$lib/server/vulnerabilities';
import { authorizeVulnAccess } from '$lib/server/vuln-access';
import { getEnvironment } from '$lib/server/db';
import { EMPTY_SUMMARY } from '$lib/utils/vulnerability';
import { rowsToCSV } from '$lib/server/csv';
import { exportResponse, jsonError, slugify } from '$lib/server/export-response';
import type { RequestHandler } from './$types';

function toCSV(findings: Finding[]): string {
	const headers = [
		'CVE', 'Severity', 'Package', 'Installed Version', 'Fixed Version',
		'Image', 'Containers', 'Stacks', 'Scanned', 'Description', 'Link'
	];
	const rows = findings.map((f) => [
		f.cve,
		f.severity,
		f.package,
		f.installedVersion,
		f.fixedVersion,
		f.imageName,
		(f.containers ?? []).map((c) => c.name).join('; '),
		(f.stacks ?? []).join('; '),
		f.scannedAt,
		f.description,
		f.link
	]);
	return rowsToCSV(headers, rows);
}

/**
 * Export the aggregated vulnerability findings as json | csv.
 * Server-side rendering so the download matches the grid data exactly.
 *
 * @openapi
 * summary: Export an environment's aggregated vulnerability findings as json or csv, matching the grid's filters and sort
 * query: format:string Output format — json (default) or csv
 * resp-200: The findings as a downloadable json or csv attachment
 * resp-200-desc: A permission failure returns the status from the access check; 500 is returned on an export error
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const { envIdNum, denied } = await authorizeVulnAccess(cookies, url);
	if (denied) return jsonError(denied.message, denied.status);

	try {
		// Apply the same filter + sort the grid uses so the export matches the
		// on-screen view (and reuse the cached flatten).
		const query = parseVulnerabilitiesQuery(url);
		const findings = envIdNum ? await getFilteredSortedFindings(envIdNum, query) : [];
		const summary = envIdNum ? (await getVulnerabilitiesMeta(envIdNum)).summary : EMPTY_SUMMARY;

		const timestamp = new Date().toISOString().split('T')[0];

		// Include the environment name in the filename (e.g. vulnerabilities-local-2026-07-01.json).
		let envSlug = 'env';
		if (envIdNum) {
			const env = await getEnvironment(envIdNum);
			if (env?.name) envSlug = slugify(env.name, 'env');
		}

		return exportResponse({
			format: url.searchParams.get('format') || 'json',
			filenameBase: `vulnerabilities-${envSlug}-${timestamp}`,
			findings,
			jsonBody: { summary, findings },
			toCSV
		});
	} catch (error) {
		console.error('Error exporting vulnerabilities:', error);
		return jsonError('Failed to export vulnerabilities', 500);
	}
};
