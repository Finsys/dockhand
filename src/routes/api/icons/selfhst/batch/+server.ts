import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSelfhstIcon, sanitizeRefList } from '$lib/server/selfhst-icons';

// Cap how many refs one call resolves, and how many upstream fetches run at once,
// so a single request can't fan out into an unbounded burst of CDN fetches.
const MAX_REFS = 200;
const CONCURRENCY = 8;

/**
 * POST /api/icons/selfhst/batch - resolve many selfh.st icons in ONE request.
 *
 * The icon picker renders a grid of app logos; fetching each as its own
 * <img src="/api/icons/selfhst/<ref>"> makes dozens of distinct requests in a
 * second, which a WAF (CrowdSec) flags as crawling/probing and blocks the client
 * (#1467). This batches them: the client asks for all visible refs at once and gets
 * one response, so the WAF sees a single request. Refs that can't be resolved are
 * simply omitted (no per-icon 404s, which also read as probing).
 *
 * Each icon is returned as a `data:image/svg+xml` URI so the picker keeps rendering
 * via <img> (script-inert) rather than inlining SVG markup - the SVG sanitizer was
 * designed for the <img>+CSP path, so we don't weaken it by switching to {@html}.
 *
 * @openapi
 * summary: Resolve multiple selfh.st app icons in one request (avoids per-icon requests a WAF flags as crawling)
 * description: Takes a list of selfh.st icon references and returns each resolved icon as a data:image/svg+xml URI, keyed by reference. Unresolvable or invalid refs are omitted rather than returned as errors. Each icon is fetched from the CDN once and cached on disk, same as the single-icon endpoint.
 * body: {refs:array<string>!}
 * body-example: {"refs":["plex","gitea","grafana"]}
 * resp-200: {icons:object!}
 * resp-200-desc: icons maps each resolved reference to a data:image/svg+xml base64 URI; unresolvable refs are omitted.
 * resp-200-example: {"icons":{"plex":"data:image/svg+xml;base64,PHN2Zy4uLg=="}}
 * resp-400: The request body is missing a refs array
 */
export const POST: RequestHandler = async ({ request }) => {
	let body: { refs?: unknown };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}
	if (!Array.isArray(body.refs)) {
		return json({ error: 'Body must include a refs array' }, { status: 400 });
	}

	// De-dupe, validate, and cap before doing any work.
	const refs = sanitizeRefList(body.refs, MAX_REFS);

	const icons: Record<string, string> = {};
	let next = 0;
	async function worker(): Promise<void> {
		while (next < refs.length) {
			const ref = refs[next++];
			const buf = await getSelfhstIcon(ref);
			// data: URI so the picker renders via <img> (script-inert), keeping the same
			// safety posture as the single-icon endpoint.
			if (buf) icons[ref] = `data:image/svg+xml;base64,${buf.toString('base64')}`;
		}
	}
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, refs.length) }, worker));

	return json(
		{ icons },
		{
			headers: {
				// The picker re-opens often; let the browser cache the batch briefly so a
				// re-open of the same grid doesn't re-hit the server at all.
				'Cache-Control': 'private, max-age=300'
			}
		}
	);
};
