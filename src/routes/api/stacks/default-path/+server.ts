import { json } from '@sveltejs/kit';
import { getStackDir } from '$lib/server/stacks';
import type { RequestHandler } from './$types';

/**
 * Get the default path for a new stack
 * Used by the UI to show where files will be created
 *
 * Query params:
 * - name: Stack name (required)
 * - env: Environment ID (optional)
 *
 * Uses STACKS_DIR/<stackName>/ when STACKS_DIR is set, otherwise
 * falls back to Dockhand's built-in $DATA_DIR/stacks/{envName}/{stackName}/ layout.
 */
export const GET: RequestHandler = async ({ url }) => {
	const stackName = url.searchParams.get('name');
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	if (!stackName) {
		return json({ error: 'Stack name is required' }, { status: 400 });
	}

	const stackDir = await getStackDir(stackName, envIdNum);

	return json({
		stackDir,
		composePath: `${stackDir}/compose.yaml`,
		envPath: `${stackDir}/.env`,
		source: process.env.STACKS_DIR ? 'configured' : 'default'
	});
};
