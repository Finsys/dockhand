import { json } from '@sveltejs/kit';
import { join } from 'path';
import { getStackDir } from '$lib/server/stacks';
import { getEnvironment } from '$lib/server/db';
import type { RequestHandler } from './$types';

/**
 * Get the default path for a new stack — used by the UI to show where files will be created.
 * With location set the path is {location}/{envName}/{stackName}/, otherwise Dockhand's
 * default $DATA_DIR/stacks/{envName}/{stackName}/.
 *
 * @openapi
 * summary: Compute the default compose/env file paths for a new stack, either under a custom base location or under Dockhand's default stacks directory
 * query: name:string! Stack name
 * query: env:integer Environment ID (scopes the path under the environment name) (from GET /api/environments)
 * query: location:string Custom base location path
 * resp-200: {stackDir:string!, composePath:string!, envPath:string!, source:string!}
 * resp-200-example: {"stackDir":"/data/stacks/prod/web","composePath":"/data/stacks/prod/web/compose.yaml","envPath":"/data/stacks/prod/web/.env","source":"default"}
 * resp-400: Stack name is required
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
