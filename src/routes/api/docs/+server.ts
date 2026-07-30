import { json, error } from '@sveltejs/kit';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RequestHandler } from './$types';

// Written by `npm run generate:openapi` (scripts/generate-openapi.ts), which
// runs as part of the regular build (see package.json "prebuild:openapi").
// Served straight off disk rather than imported, so a re-generated spec is
// picked up on the next request without a server restart in dev.
const SPEC_PATH = join(process.cwd(), 'static', 'openapi.json');

/**
 * @openapi
 * summary: The full OpenAPI 3.0 specification for the Dockhand REST API (unauthenticated)
 * resp-200: object
 * resp-200-desc: The generated OpenAPI document — see GET /api/docs/ui for an interactive viewer
 * resp-404: Spec not generated yet — run `npm run generate:openapi`
 */
export const GET: RequestHandler = async () => {
	if (!existsSync(SPEC_PATH)) {
		throw error(404, 'OpenAPI spec not generated yet — run `npm run generate:openapi`');
	}
	const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf-8'));
	return json(spec);
};
