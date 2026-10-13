import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSelfhstIcon, isValidSelfhstRef } from '$lib/server/selfhst-icons';

// Security headers applied to every icon response regardless of format. An SVG is
// sanitized at cache time; raster formats are inert. These are belt-and-braces so even
// a direct navigation to this URL cannot execute embedded content. Content-Type is set
// per response from the resolved format.
const SECURITY_HEADERS = {
	'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
	'X-Content-Type-Options': 'nosniff'
} as const;

// A neutral placeholder returned (200) when an icon can't be resolved, instead of a
// 404. A grid of icons where several 404 reads like probing to a WAF (CrowdSec) and
// gets the client blocked (#1467); a 200 placeholder that the UI can still show avoids
// that while looking the same to the user as the old fallback glyph.
const PLACEHOLDER_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 12h8"/></svg>';

/**
 * @openapi
 * summary: Get a selfh.st app icon, fetched once from the CDN and cached on disk
 * description: Proxies an icon from the selfh.st collection so the browser never contacts an external CDN directly. The first request for a given ref fetches it from jsdelivr in the first available format (SVG, else WebP, else PNG - about 16% of the collection has no SVG) and caches it under DATA_DIR; later requests are served locally. Icons are CC BY 4.0 (selfh.st). When the icon can't be resolved in any format it returns a neutral placeholder SVG (200) rather than a 404, so a grid of icons doesn't read as probing to a WAF.
 * path: ref:string! selfh.st icon Reference (lowercase letters, digits, hyphens), e.g. "plex"
 * resp-200: Raw image body (image/svg+xml, image/webp, or image/png; a neutral SVG placeholder if it can't be resolved), Cache-Control public max-age=604800
 * resp-400: The ref is not a valid selfh.st reference
 */
export const GET: RequestHandler = async ({ params }) => {
	const ref = params.ref;
	if (!isValidSelfhstRef(ref)) {
		return json({ error: 'Invalid icon reference' }, { status: 400 });
	}
	const icon = await getSelfhstIcon(ref);
	if (!icon) {
		// A short cache so a ref that resolves later (transient CDN failure) is retried
		// soon, but repeated views in the meantime don't re-hit the server.
		return new Response(PLACEHOLDER_SVG, {
			headers: { ...SECURITY_HEADERS, 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=300' }
		});
	}
	return new Response(new Uint8Array(icon.buffer), {
		headers: { ...SECURITY_HEADERS, 'Content-Type': icon.contentType, 'Cache-Control': 'public, max-age=604800' }
	});
};
