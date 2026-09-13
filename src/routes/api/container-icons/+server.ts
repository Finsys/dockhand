import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { getContainerIconOverrides } from '$lib/server/db';

function parseEnv(raw: string | null): number | null {
	if (!raw) return null;
	const n = parseInt(raw, 10);
	return Number.isNaN(n) ? null : n;
}

/**
 * @openapi
 * summary: List all container icon overrides for an environment as a name -> icon map
 * description: Returns every container that has a user-set icon override in the given environment, so the containers list can render them in one request instead of one lookup per row.
 * query: env:integer Environment id
 * resp-200: A JSON object mapping container name to its icon value (lucide name, `selfhst:<ref>`, or `custom:container`)
 * resp-200-example: {"plex":"selfhst:plex","db":"custom:container"}
 * resp-403: Permission denied (needs containers:view)
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);
	const envId = parseEnv(url.searchParams.get('env'));
	if (auth.authEnabled && !(await auth.can('containers', 'view', envId ?? undefined))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	return json(await getContainerIconOverrides(envId));
};
