import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
// Written by `npm run generate:openapi` (scripts/generate-openapi.ts), which
// runs as part of the regular build (see package.json "prebuild"). Imported
// as a module rather than read from disk at request time: the production
// Docker image only copies build/ (not static/), so a static/-only spec
// would 404 in the container even though it's present in the repo. Importing
// it makes Vite bundle the spec straight into the built server output,
// so it's always available regardless of what ships alongside build/.
import spec from '$lib/openapi.generated.json';

/**
 * @openapi
 * summary: The full OpenAPI 3.0 specification for the Dockhand REST API (unauthenticated)
 * resp-200: object
 * resp-200-desc: The generated OpenAPI document — see GET /api/docs/ui for an interactive viewer
 */
export const GET: RequestHandler = async () => {
	return json(spec);
};
