import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { parseEnvParam } from '$lib/server/env-param';
import { getStackTagsMap } from '$lib/server/db';

/**
 * @openapi
 * summary: List all stack tag assignments for an environment as a name -> tagIds map
 * description: Returns every stack that has tags assigned in the given environment, so the stacks list can render and filter by tag in one request.
 * query: env:integer Environment id
 * resp-200: A JSON object mapping stack name to its array of tag ids
 * resp-200-example: {"nextcloud":[2],"traefik":[4]}
 * resp-403: Permission denied (needs stacks:view)
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);
	const envId = parseEnvParam(url.searchParams.get('env'));
	if (auth.authEnabled && !(await auth.can('stacks', 'view', envId ?? undefined))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	return json(await getStackTagsMap(envId));
};
