import { error } from '@sveltejs/kit';
import { createHash } from 'node:crypto';
import type { RequestHandler } from './$types';
import { API_DOCS_ENABLED } from '$lib/server/features';
// Written by `npm run generate:openapi` (scripts/generate-openapi.ts), which
// runs as part of the regular build (see package.json "prebuild"). Imported
// as a module rather than read from disk at request time: the production
// Docker image only copies build/ (not static/), so a static/-only spec
// would 404 in the container even though it's present in the repo. Importing
// it makes Vite bundle the spec straight into the built server output,
// so it's always available regardless of what ships alongside build/.
import spec from '$lib/openapi.generated.json';

// The spec is immutable at runtime (baked into the build), so serialize it and
// hash its ETag ONCE at module load - not on every request. The doc is ~800 KB;
// re-stringifying it per request is wasted CPU, and without an ETag the Scalar
// viewer re-downloads the whole thing on every open.
const SPEC_JSON = JSON.stringify(spec);
const SPEC_ETAG = `"${createHash('sha1').update(SPEC_JSON).digest('base64url')}"`;

/**
 * @openapi
 * summary: The full OpenAPI 3.0 specification for the Dockhand REST API (unauthenticated)
 * resp-200: object
 * resp-200-desc: The generated OpenAPI document — see GET /api/docs/ui for an interactive viewer
 * resp-304: Not modified — the client's If-None-Match matches the current spec ETag
 * resp-404: Not found — API docs are disabled (set FEAT_API_DOCS=true to enable)
 */
export const GET: RequestHandler = async ({ request }) => {
	// Gated: unauthenticated route, opt-in per instance (see features.ts).
	if (!API_DOCS_ENABLED) throw error(404, 'Not found');

	// max-age is short so a redeploy (new spec, new ETag) is picked up quickly;
	// the ETag then serves 304s within that window instead of re-sending ~800 KB.
	const headers = {
		'content-type': 'application/json',
		etag: SPEC_ETAG,
		'cache-control': 'public, max-age=300'
	};

	if (request.headers.get('if-none-match') === SPEC_ETAG) {
		return new Response(null, { status: 304, headers });
	}
	return new Response(SPEC_JSON, { headers });
};
