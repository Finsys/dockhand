import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import changelog from '$lib/data/changelog.json';

/**
 * GET /api/changelog - Dockhand changelog
 *
 * @openapi
 * summary: Return the bundled Dockhand changelog data
 * resp-200: array<{version:string!, date:string, changes:array<string>}>
 * resp-200-example: [{"version":"1.0.39","date":"2026-06-01","changes":["Fixed image export streaming"]}]
 */
export const GET: RequestHandler = async () => {
	return json(changelog);
};
