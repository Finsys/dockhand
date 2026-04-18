import { json } from '@sveltejs/kit';
import { getStacksDir } from '$lib/server/stacks';
import type { RequestHandler } from './$types';

/**
 * GET /api/stacks/base-path
 *
 * Returns the current stacks base path.
 */
export const GET: RequestHandler = async () => {
	const basePath = getStacksDir();
	return json({ basePath });
};
