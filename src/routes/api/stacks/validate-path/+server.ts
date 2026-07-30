import { json, type RequestHandler } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import { validatePath } from '$lib/server/stack-scanner';
import { getExternalStackPaths } from '$lib/server/db';

/**
 * @openapi
 * summary: Validate a candidate external stack path (exists, is a directory, no overlap with already-configured paths); validation failures are returned as 200 with valid=false
 * body: {path:string!}
 * body-example: {"path":"/opt/external-stacks"}
 * resp-200: {valid:boolean!, error:string}
 * resp-200-example: {"valid":false,"error":"Path does not exist"}
 * resp-403: Permission denied (requires settings:edit)
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('settings', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const { path } = await request.json();

		if (!path || typeof path !== 'string') {
			return json({ valid: false, error: 'Path is required' });
		}

		// Get existing paths to check for overlaps
		const existingPaths = await getExternalStackPaths();

		const result = validatePath(path, existingPaths);
		return json(result);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		return json({ valid: false, error: message });
	}
};
