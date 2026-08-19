/**
 * Prometheus metrics endpoint (#339), served at /metrics (Prometheus convention).
 *
 * Gating:
 *  - Disabled unless EXPORT_METRICS=true → 404 (looks like the route doesn't exist).
 *  - When app auth is DISABLED, /metrics is public (mirrors /api/health), so a
 *    trusted-network scrape works out of the box.
 *  - When app auth is ENABLED, a valid session OR API bearer token is required
 *    (authorize() handles both) → 401 otherwise. Prometheus scrapes with a
 *    `authorization: { credentials: <token> }`.
 */
import { authorize } from '$lib/server/authorize';
import { METRICS_ENABLED, renderMetrics, metricsContentType } from '$lib/server/metrics';
import type { RequestHandler } from './$types';

/**
 * @openapi
 * summary: Prometheus metrics endpoint (disabled and 404s unless EXPORT_METRICS=true; public if app auth is disabled, otherwise requires a session or bearer token)
 * resp-200: Prometheus text-exposition-format metrics body
 * resp-401: Not authenticated (session or bearer token required when app auth is enabled)
 * resp-404: Metrics export disabled (EXPORT_METRICS is not true)
 * resp-500: Metrics collection failed
 */
export const GET: RequestHandler = async ({ cookies }) => {
	if (!METRICS_ENABLED) {
		return new Response('Not found', { status: 404 });
	}

	const auth = await authorize(cookies);
	if (auth.authEnabled && !auth.isAuthenticated) {
		return new Response('Unauthorized', {
			status: 401,
			headers: { 'WWW-Authenticate': 'Bearer' }
		});
	}

	try {
		const body = await renderMetrics();
		return new Response(body, {
			status: 200,
			headers: { 'Content-Type': metricsContentType }
		});
	} catch (error) {
		console.error('[metrics] render failed:', error);
		return new Response('# metrics collection failed\n', {
			status: 500,
			headers: { 'Content-Type': 'text/plain' }
		});
	}
};
