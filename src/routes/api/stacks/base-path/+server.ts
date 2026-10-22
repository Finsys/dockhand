import { json } from '@sveltejs/kit';
import { getStacksBasePathForEnv } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';
import type { RequestHandler } from './$types';

/**
 * GET /api/stacks/base-path
 *
 * @openapi
 * summary: Return the default Dockhand stacks directory ($DATA_DIR/stacks/) where new stacks are stored by default
 * query: env:integer Environment ID used to select the local or environment-scoped stacks root
 * resp-200: {basePath:string!}
 * resp-200-example: {"basePath":"/data/stacks"}
 * resp-403: Permission denied (needs stacks:view, and access to the environment)
 *
 * Returns the Dockhand stacks root for the requested environment context.
 * Query params:
 * - env: Environment ID (optional) — when set, returns STACKS_DIR for local envs
 *   with STACKS_DIR configured, otherwise $DATA_DIR/stacks (staging / legacy).
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	// A host filesystem path, held to the same permission as the rest of the stack
	// layout. Its only caller is the stack file browser.
	const auth = await authorize(cookies);
	const permDenied = await auth.requirePermission('stacks', 'view');
	if (permDenied) return permDenied;

	const envParam = url.searchParams.get('env');
	const envIdNum = envParam ? parseInt(envParam) : undefined;
	const resolvedEnvId =
		envIdNum !== undefined && !Number.isNaN(envIdNum) ? envIdNum : undefined;

	const envDenied = await auth.requireEnvAccess(resolvedEnvId);
	if (envDenied) return envDenied;

	const basePath = await getStacksBasePathForEnv(resolvedEnvId);
	return json({ basePath });
};
