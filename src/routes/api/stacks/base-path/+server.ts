import { json } from '@sveltejs/kit';
import { getStacksDir } from '$lib/server/stacks';
import type { RequestHandler } from './$types';

/**
 * GET /api/stacks/base-path
 *
 * Returns the default Dockhand stacks directory path.
 * This is where stacks are stored by default ($DATA_DIR/stacks/).
 */
export const GET: RequestHandler = async () => {
	const basePath = getStacksDir();
	return json({ basePath });
};
