import { json } from '@sveltejs/kit';
import { join } from 'path';
import { getStackDir } from '$lib/server/stacks';
import { getEnvironment } from '$lib/server/db';
import type { RequestHandler } from './$types';

/**
 * Get the default path for a new stack
 * Used by the UI to show where files will be created
 *
 * Query params:
 * - name: Stack name (required)
 * - env: Environment ID (optional)
 * - location: Custom base location path (optional)
 *
 * If location is provided, path will be: {location}/{envName}/{stackName}/
 * Otherwise uses Dockhand's default: $DATA_DIR/stacks/{envName}/{stackName}/
 */
export const GET: RequestHandler = async ({ url }) => {
	const stackName = url.searchParams.get('name');
	const envId = url.searchParams.get('env');
	const location = url.searchParams.get('location');
	const envIdNum = envId ? parseInt(envId) : undefined;

	if (!stackName) {
		return json({ error: 'Stack name is required' }, { status: 400 });
	}

	let stackDir: string;

	if (location) {
		// Custom location: {location}/{envName}/{stackName}/
		if (envIdNum) {
			const env = await getEnvironment(envIdNum);
			if (env) {
				stackDir = join(location, env.name, stackName);
			} else {
				stackDir = join(location, stackName);
			}
		} else {
			stackDir = join(location, stackName);
		}
	} else {
		// Dockhand default location
		stackDir = await getStackDir(stackName, envIdNum);
	}

	return json({
		stackDir,
		composePath: `${stackDir}/compose.yaml`,
		envPath: `${stackDir}/.env`,
		source: 'default'
	});
};
