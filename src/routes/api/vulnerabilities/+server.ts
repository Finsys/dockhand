import { json } from '@sveltejs/kit';
import { getVulnerabilitiesPage, parseVulnerabilitiesQuery } from '$lib/server/vulnerabilities';
import { authorizeVulnAccess } from '$lib/server/vuln-access';
import type { RequestHandler } from './$types';

/**
 * A page of aggregated vulnerability findings for an environment, filtered and
 * sorted server-side. Query: limit, offset, q, severity, image, container,
 * stack, sort, dir. Returns { findings, total } where `total` is the filtered
 * count (for the "X-Y of N" counter and infinite scroll).
 *
 * @openapi
 * summary: A filtered, sorted page of aggregated vulnerability findings for an environment
 * description: Accepts limit, offset, q, severity, image, container, stack, sort and dir query params (parsed centrally). Returns an empty page when no environment resolves.
 * resp-200: {findings:array<object>!, total:integer!}
 * resp-200-desc: A page of findings plus the filtered total count; a permission failure returns the status from the access check
 * resp-200-example: {"findings":[{"cve":"CVE-2024-0001","severity":"high","package":"openssl","imageName":"nginx:latest"}],"total":1}
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const { envIdNum, denied } = await authorizeVulnAccess(cookies, url);
	if (denied) return json({ error: denied.message }, { status: denied.status });
	if (!envIdNum) return json({ findings: [], total: 0 });

	const result = await getVulnerabilitiesPage(envIdNum, parseVulnerabilitiesQuery(url));
	return json(result);
};
