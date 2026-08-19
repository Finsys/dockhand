/**
 * Vulnerability dashboard metadata for an environment: the total finding count,
 * the severity summary, and the distinct filter-dropdown values (image /
 * container / stack) across the full set. Lets the header badge and the filter
 * dropdowns stay complete without the page loading the full findings array.
 */
import { json } from '@sveltejs/kit';
import { getVulnerabilitiesMeta } from '$lib/server/vulnerabilities';
import { EMPTY_META } from '$lib/server/vulnerabilities-cache';
import { authorizeVulnAccess } from '$lib/server/vuln-access';
import type { RequestHandler } from './$types';

/**
 * GET /api/vulnerabilities/count - Vulnerability dashboard metadata
 *
 * @openapi
 * summary: Return the total finding count, severity summary, and distinct image/container/stack filter values for an environment
 * resp-200: {total:integer!, summary:object!, images:array<string>!, containers:array<string>!, stacks:array<string>!}
 * resp-200-desc: An empty metadata object is returned when no environment resolves; a permission failure returns the status from the access check
 * resp-200-example: {"total":12,"summary":{"critical":1,"high":3,"medium":5,"low":3},"images":["nginx:latest"],"containers":["web"],"stacks":["frontend"]}
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const { envIdNum, denied } = await authorizeVulnAccess(cookies, url);
	if (denied) return json({ error: denied.message }, { status: denied.status });
	if (!envIdNum) return json(EMPTY_META);

	const meta = await getVulnerabilitiesMeta(envIdNum);
	return json(meta);
};
