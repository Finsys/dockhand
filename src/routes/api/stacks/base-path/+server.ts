import { json } from '@sveltejs/kit';
import { getStacksDir } from '$lib/server/stacks';
import type { RequestHandler } from './$types';

/**
 * GET /api/stacks/base-path
 *
 * @openapi
 * summary: Return the default Dockhand stacks directory ($DATA_DIR/stacks/) where new stacks are stored by default
 * resp-200: {basePath:string!}
 * resp-200-example: {"basePath":"/data/stacks"}
 */
export const GET: RequestHandler = async () => {
	const basePath = getStacksDir();
	return json({ basePath });
};
