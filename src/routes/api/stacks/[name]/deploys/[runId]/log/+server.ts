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
 * description: 400 ("Invalid run id") is produced by the shared loadOwnedDeployRun() helper (deploy-run-access.ts), not literally in this handler's body -- the openapi generator's static scanner cannot see status()/error() calls in a different file, hence the prose here instead of a resp-400 line (same pattern as POST /api/backup/destinations/{id}/task's description). The 404 below covers BOTH loadOwnedDeployRun's "run not found / belongs to a different stack" AND this handler's own "log file missing" -- the latter IS literal in this file's body, which is why it can stay a resp-404 line.
 * path: name:string! Stack name (from GET /api/stacks)
 * path: runId:integer! Run id (from GET /api/stacks/{name}/deploys)
 * resp-200: Plain-text log content
 * resp-401: Authentication required
 * resp-403: Permission denied (needs stacks:view for the run's own environment), or access denied to this environment
 * resp-404: Deploy run not found (also returned for a run that belongs to a different stack), or log file missing
 */
export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);

	if (auth.authEnabled && !auth.isAuthenticated) {
		return json({ error: 'Authentication required' }, { status: 401 });
	}
	// Coarse gate -- see the identical comment in
	// .../deploys/[runId]/+server.ts's GET handler.
	if (auth.authEnabled && !(await auth.can('stacks', 'view'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const stackName = decodeURIComponent(params.name);
	const loaded = await loadOwnedDeployRun(stackName, params.runId, auth);
	if ('response' in loaded) return loaded.response;

	const { run } = loaded;

	// Scoped to the RUN's OWN environment -- see the identical comment in
	// .../deploys/[runId]/+server.ts's GET handler for why this runs in
	// addition to, and after, the coarse gate above. This is the MOST
	// sensitive of the three routes (it is the one that can carry secrets
	// that survived redaction, see the module doc comment below), so this
	// check runs BEFORE readRunLog() ever touches the file.
	if (auth.authEnabled && !(await auth.can('stacks', 'view', run.environmentId ?? undefined))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const log = await readRunLog(String(run.id));
	if (log === null) {
		return json({ error: 'Log not found' }, { status: 404 });
	}

	return new Response(log, { headers: { 'content-type': 'text/plain' } });
};
