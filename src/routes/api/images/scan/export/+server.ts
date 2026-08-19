/**
 * Per-image vulnerability export (#415): reformats the cached scan for one image
 * as json | csv | sarif for CI / DefectDojo / Dependency-Track integration.
 * Read-only over persisted scans; no new scanning. Auth via cookie or Bearer
 * token (CI), with RBAC + enterprise environment scoping.
 */
import { getScansForImage, getEnvironment } from '$lib/server/db';
import { flattenScansToFindings } from '$lib/server/vulnerabilities';
import { authorizeVulnAccess } from '$lib/server/vuln-access';
import { rowsToCSV } from '$lib/server/csv';
import { exportResponse, jsonError, slugify } from '$lib/server/export-response';
import type { Finding } from '$lib/utils/vulnerability';
import type { RequestHandler } from './$types';

function toCSV(findings: Finding[]): string {
	const headers = ['CVE', 'Severity', 'Package', 'Installed Version', 'Fixed Version', 'Image', 'Scanned', 'Description', 'Link'];
	const rows = findings.map((f) => [
		f.cve, f.severity, f.package, f.installedVersion, f.fixedVersion, f.imageName, f.scannedAt, f.description, f.link
	]);
	return rowsToCSV(headers, rows);
}

/**
 * GET /api/images/scan/export - Export one image's cached findings (json|csv|sarif)
 *
 * @openapi
 * summary: Export the cached vulnerability findings for a single image as json, csv, or sarif
 * query: imageId:string! Image SHA/ID to export (falls back to the "image" param when omitted) (from GET /api/images)
 * query: image:string Image name/ID used as a fallback when imageId is not given
 * query: format:string Output format — json (default), csv, or sarif
 * resp-200: The findings as a downloadable json, csv, or sarif attachment
 * resp-200-desc: A 400 is returned when imageId is missing or (auth enabled) env is not specified, and 500 on failure
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const imageId = url.searchParams.get('imageId') || url.searchParams.get('image');
	if (!imageId) return jsonError('imageId is required', 400);

	// RBAC (images:view) + enterprise environment scoping, shared with the other
	// vuln endpoints. Auth via cookie or Bearer token is handled inside authorize().
	const { envIdNum, denied, authEnabled } = await authorizeVulnAccess(cookies, url);
	if (denied) return jsonError(denied.message, denied.status);

	// The same image SHA can be scanned in multiple environments. When auth is on,
	// require an explicit env so the tenant-scoping check in authorizeVulnAccess
	// actually runs — otherwise a user scoped to env A could read env B's scans by
	// omitting env (CWE-639). Free/open mode has no tenant boundary to enforce.
	if (authEnabled && envIdNum === undefined) {
		return jsonError('env is required', 400);
	}

	try {
		// Always scope the query by env so cross-environment scans are never returned,
		// even if an access check were somehow bypassed (defense in depth).
		const scans = await getScansForImage(imageId, envIdNum);
		const findings = flattenScansToFindings(scans);

		const timestamp = new Date().toISOString().split('T')[0];
		const imageSlug = findings[0]?.imageName
			? slugify(findings[0].imageName, 'image')
			: slugify(imageId.replace('sha256:', '').slice(0, 12), 'image');

		let envSlug = '';
		if (envIdNum) {
			const env = await getEnvironment(envIdNum);
			if (env?.name) envSlug = `-${slugify(env.name, 'env')}`;
		}

		return exportResponse({
			format: url.searchParams.get('format') || 'json',
			filenameBase: `vulnerabilities-${imageSlug}${envSlug}-${timestamp}`,
			findings,
			jsonBody: { imageId, findings },
			toCSV
		});
	} catch (error) {
		console.error('Error exporting image vulnerabilities:', error);
		return jsonError('Failed to export image vulnerabilities', 500);
	}
};
