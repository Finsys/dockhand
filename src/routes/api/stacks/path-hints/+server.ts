import { json, type RequestHandler } from '@sveltejs/kit';
import { getStackPathHints } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';

/**
 * GET /api/stacks/path-hints?name=stackName&env=envId
 * Returns path hints extracted from Docker container labels for a stack.
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !auth.isAuthenticated) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const stackName = url.searchParams.get('name');
	const envId = url.searchParams.get('env');

	if (!stackName) {
		return json({ error: 'Stack name is required' }, { status: 400 });
	}

	try {
		const hints = await getStackPathHints(stackName, envId ? parseInt(envId) : undefined);

		return json({
			stackName,
			workingDir: hints.workingDir,
			configFiles: hints.configFiles
		});
	} catch (error) {
		console.error('Failed to get stack path hints:', error);
		return json(
			{ error: error instanceof Error ? error.message : 'Failed to get path hints' },
			{ status: 500 }
		);
	}
};
