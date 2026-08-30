import { json } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import { loadOwnedDeployRun } from '$lib/server/deploy-run-access';
import { readRunLog } from '$lib/server/deploy-log-store';
import type { RequestHandler } from './$types';

/**
 * GET /api/stacks/[name]/deploys/[runId]/log
 *
 * The run's protocol text, straight from the file (Task 5) as text/plain.
 *
 * This is the most sensitive of the four operations -- it is the one that can
 * actually carry secrets that survived redaction -- so it MUST NOT come out
 * looking safe just because a file path happened to be unresolvable. Every
 * check below runs BEFORE the file is ever touched: authentication, then
 * stacks:view, then ownership+environment access via loadOwnedDeployRun (the
 * exact same helper GET/DELETE .../deploys/{runId} use, so this route can
 * never drift into trusting a run it shouldn't). Only once all of that has
 * passed does readRunLog() run at all.
 */
/**
 * @openapi
 * summary: Get a deploy run's log text (text/plain, from the on-disk file)
 * path: name:string! Stack name (from GET /api/stacks)
 * path: runId:integer! Run id (from GET /api/stacks/{name}/deploys)
 * resp-200: Plain-text log content
 * resp-400: Invalid run id
 * resp-401: Authentication required
 * resp-403: Permission denied (needs stacks:view), or access denied to this environment
 * resp-404: Deploy run not found (also returned for a run that belongs to a different stack), or log file missing
 */
export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);

	if (auth.authEnabled && !auth.isAuthenticated) {
		return json({ error: 'Authentication required' }, { status: 401 });
	}
	if (auth.authEnabled && !(await auth.can('stacks', 'view'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const stackName = decodeURIComponent(params.name);
	const loaded = await loadOwnedDeployRun(stackName, params.runId, auth);
	if ('response' in loaded) return loaded.response;

	const { run } = loaded;
	const log = await readRunLog(String(run.id));
	if (log === null) {
		return json({ error: 'Log not found' }, { status: 404 });
	}

	return new Response(log, { headers: { 'content-type': 'text/plain' } });
};
