import { json } from '@sveltejs/kit';
import { deleteScheduleExecution } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { deleteRunLog } from '$lib/server/deploy-log-store';
import { loadOwnedDeployRun } from '$lib/server/deploy-run-access';
import type { RequestHandler } from './$types';

/**
 * GET /api/stacks/[name]/deploys/[runId]
 *
 * A single deploy run with all its metadata (no log text -- see .../log).
 */
/**
 * @openapi
 * summary: Get a single deploy run's metadata (no log text -- see GET .../{runId}/log)
 * description: 400 ("Invalid run id") and 404 ("Deploy run not found", also returned for a run that belongs to a different stack) are produced by the shared loadOwnedDeployRun() helper (deploy-run-access.ts), not literally in this handler's body -- the openapi generator's static scanner cannot see status()/error() calls in a different file, hence the prose here instead of resp-400/resp-404 lines (same pattern as POST /api/backup/destinations/{id}/task's description).
 * path: name:string! Stack name (from GET /api/stacks)
 * path: runId:integer! Run id (from GET /api/stacks/{name}/deploys)
 * resp-200: {id:integer!, environmentId:integer, triggeredBy:string!, triggeredAt:string!, startedAt:string, completedAt:string, duration:integer, status:string!, errorMessage:string, details:{}}
 * resp-401: Authentication required
 * resp-403: Permission denied (needs stacks:view for the run's own environment), or access denied to this environment
 */
export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);

	// Authentication gate first: a caller without a session gets 401 here, not
	// a 403 indistinguishable from "logged in but lacking the permission".
	if (auth.authEnabled && !auth.isAuthenticated) {
		return json({ error: 'Authentication required' }, { status: 401 });
	}
	// Coarse gate: reject a caller who lacks stacks:view EVERYWHERE, before
	// even touching the database. This does not by itself scope to the run's
	// environment (see the check below) -- it only screens out someone with
	// no stacks:view grant on any role at all.
	if (auth.authEnabled && !(await auth.can('stacks', 'view'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const stackName = decodeURIComponent(params.name);
	const loaded = await loadOwnedDeployRun(stackName, params.runId, auth);
	if ('response' in loaded) return loaded.response;

	const { run } = loaded;

	// Scoped to the RUN's OWN environment, checked ADDITIONALLY and AFTER the
	// coarse gate above -- it needs run.environmentId, which only exists once
	// loadOwnedDeployRun has resolved it. Without this, a caller with
	// stacks:view for SOME environment (which already satisfied the coarse
	// gate above via the global OR-across-roles merge) but not for THIS run's
	// environment could read a run from an environment they have no
	// stacks:view grant on at all. Same idea the sibling list route
	// (deploys/+server.ts) already documents for itself, and the same pattern
	// api/git/stacks/[id]/+server.ts and env-files/+server.ts use: derive the
	// environment from the loaded entity, then check permission against THAT.
	// `?? undefined` maps a local run (NULL environmentId) to the same
	// "no environment context" global-permission check those routes use for
	// their own nullable environmentId (`gitStack.environmentId || undefined`).
	if (auth.authEnabled && !(await auth.can('stacks', 'view', run.environmentId ?? undefined))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	return json({
		id: run.id,
		environmentId: run.environmentId,
		triggeredBy: run.triggeredBy,
		triggeredAt: run.triggeredAt,
		startedAt: run.startedAt,
		completedAt: run.completedAt,
		duration: run.duration,
		status: run.status,
		errorMessage: run.errorMessage,
		details: run.details
	});
};

/**
 * DELETE /api/stacks/[name]/deploys/[runId]
 *
 * Removes both the database record AND the on-disk log file. Deleting only
 * one half would either leave an orphaned log file nobody can reach (record
 * gone), or a record that 404s the moment someone tries to read its log (file
 * gone) -- so both happen together, file first: if the file delete throws,
 * the record still exists and a retry can clean up the rest; the reverse
 * order would leave a log file with no record pointing at it, findable only
 * by scanning the log directory.
 */
/**
 * @openapi
 * summary: Delete a deploy run's database record and its on-disk log file
 * description: 400 ("Invalid run id") and 404 ("Deploy run not found", also returned for a run that belongs to a different stack) are produced by the shared loadOwnedDeployRun() helper (deploy-run-access.ts), not literally in this handler's body -- see GET .../{runId}'s description for why that means prose here instead of resp-400/resp-404 lines.
 * path: name:string! Stack name (from GET /api/stacks)
 * path: runId:integer! Run id (from GET /api/stacks/{name}/deploys)
 * resp-200: {success:boolean!}
 * resp-401: Authentication required
 * resp-403: Permission denied (needs stacks:edit for the run's own environment), or access denied to this environment
 */
export const DELETE: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);

	if (auth.authEnabled && !auth.isAuthenticated) {
		return json({ error: 'Authentication required' }, { status: 401 });
	}
	// Coarse gate -- see the identical comment on GET above.
	if (auth.authEnabled && !(await auth.can('stacks', 'edit'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const stackName = decodeURIComponent(params.name);
	const loaded = await loadOwnedDeployRun(stackName, params.runId, auth);
	if ('response' in loaded) return loaded.response;

	const { run } = loaded;

	// Scoped to the RUN's OWN environment -- see the identical comment on GET
	// above for why this is checked in addition to, and after, the coarse
	// gate. Checked before either delete happens: neither the log file nor
	// the database record is touched if this denies.
	if (auth.authEnabled && !(await auth.can('stacks', 'edit', run.environmentId ?? undefined))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	await deleteRunLog(String(run.id));
	await deleteScheduleExecution(run.id);

	return json({ success: true });
};
