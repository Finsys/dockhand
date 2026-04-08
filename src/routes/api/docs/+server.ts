import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { openapiSpec } from '$lib/server/openapi';

/**
 * GET /api/docs
 *
 * Returns the OpenAPI 3.0 JSON specification for the Dockhand API.
 * This endpoint is unauthenticated so external tools can consume the spec.
 */
export const GET: RequestHandler = async () => {
	return json(openapiSpec);
};
