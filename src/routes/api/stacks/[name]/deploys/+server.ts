import { json } from '@sveltejs/kit';
import { getScheduleExecutions } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import type { RequestHandler } from './$types';

/**
 * GET /api/stacks/[name]/deploys?env=X
 *
 * List of deploy runs recorded for this stack. No log text here — the log
 * lives in a file (Task 5), not in this response; fetch it separately via
 * GET .../deploys/{runId}/log.
 *
 * This route does NOT inherit the no-auth model of /api/jobs/{id}: a job id
 * is an unguessable UUID that lives ten minutes in memory, while a schedule
 * execution id is a small sequential integer that persists forever. Every
 * route under .../deploys checks stacks:view for itself.
 *
 * `env` identifies WHICH environment's runs to list, unlike the other two
 * routes under .../deploys (which derive the environment from the loaded run
 * itself via loadOwnedDeployRun). A stack NAME alone is not unique -- the
 * same name can exist in more than one environment -- so a list without a
 * definite environment would either merge runs from unrelated environments
 * into one response, or get evaluated against the caller's globally-merged
 * permission instead of their permission for one specific environment:
 * `auth.can(..., undefined)` checks the OR of every role's grant across all
 * environments, not "does this caller have stacks:view for env X". A caller
 * with stacks:view scoped to exactly one environment could otherwise get
 * runs -- including timestamps, status, error text and details.userId --
 * from every environment that happens to have a same-named stack.
 *
 * Two `env` shapes both resolve to the LOCAL environment (environmentId ===
 * NULL in schedule_executions): the parameter OMITTED entirely, and the
 * literal string "null". This is not a relaxation of the paragraph above --
 * it is the environment id createRunRecorder() actually writes for a deploy
 * triggered without an explicit envId, which is the case on a single
 * (local-only) environment install: appendEnvParam() in
 * $lib/stores/environment.ts only appends `env` to the request when envId is
 * truthy, so the UI's own "deploy this stack" call for the local environment
 * NEVER sends an `env` param in the first place. Before this NULL shape was
 * recognized here, EVERY recorded run on a single-environment install was
 * unreachable through this endpoint: any non-null `env` value matches zero
 * rows (`env=0` included -- environment ids are never 0), and omitting `env`
 * was a hard 400. There is no legitimate case where "list runs, no env
 * specified" should silently mean "all environments, merged" -- an explicit,
 * distinguishable id (a real integer, or the NULL/local shape) is still
 * required for every request; only what counts as that definite id changed.
 * Anything that is neither a parseable integer nor the omitted/"null" shape
 * remains a hard 400: parsing happens before the permission check, so
 * `can()` and `canAccessEnvironment()` always see a definite id (a number,
 * or `undefined` for the local case -- never an ambiguous "no filter").
 */
/**
 * @openapi
 * summary: List deploy runs recorded for a stack (no log text -- see GET .../{runId}/log)
 * path: name:string! Stack name (from GET /api/stacks)
 * query: env:integer Environment id the stack belongs to (from GET /api/environments). Omit, or pass the literal string "null", for the local/default environment (deploys triggered without an explicit env, the normal shape on a single-environment install).
 * resp-200: {runs:array<{id:integer!, environmentId:integer, triggeredBy:string!, triggeredAt:string!, startedAt:string, completedAt:string, duration:integer, status:string!, errorMessage:string, details:{}}>!}
 * resp-400: env query parameter must be an integer, or omitted/"null" for the local environment
 * resp-401: Authentication required
 * resp-403: Permission denied (needs stacks:view), or access denied to this environment
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);

	// Authentication gate first, checked BEFORE anything else runs: a caller
	// without a session gets 401 here, not a 403 indistinguishable from "logged
	// in but lacking the permission", and not some later error from touching the
	// database without a user.
	if (auth.authEnabled && !auth.isAuthenticated) {
		return json({ error: 'Authentication required' }, { status: 401 });
	}

	// env is resolved to a definite id -- a real integer, or `null` for the
	// local environment (see the module doc comment above) -- BEFORE the
	// permission check below, so `can()` never falls back to the caller's
	// globally-merged permission across all environments. NEVER left
	// `undefined` past this point: passed straight through to
	// getScheduleExecutions(), where `environmentId: undefined` means "do not
	// filter on environment at all" (every environment's runs), while
	// `environmentId: null` means "only NULL-environment runs" -- the two are
	// not interchangeable, and only the second is what "local environment"
	// must mean here.
	const envIdParam = url.searchParams.get('env');
	let envIdNum: number | null;
	if (envIdParam === null || envIdParam === 'null') {
		envIdNum = null;
	} else {
		const parsed = parseInt(envIdParam, 10);
		if (isNaN(parsed)) {
			return json(
				{ error: 'env query parameter must be an integer, or omitted/"null" for the local environment' },
				{ status: 400 }
			);
		}
		envIdNum = parsed;
	}

	// `?? undefined` maps the local environment (null) to the same "no
	// environment context" global-permission check `can()` performs for
	// git-stack routes with a nullable environmentId (`gitStack.environmentId
	// || undefined` in api/git/stacks/[id]/+server.ts) -- there is no
	// per-environment role to scope against for a run that was never
	// attributed to one.
	if (auth.authEnabled && !(await auth.can('stacks', 'view', envIdNum ?? undefined))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// The local environment has no environment record to check access
	// against -- canAccessEnvironment() takes a required numeric id and would
	// throw or misbehave on null/undefined, and there is nothing to be denied
	// access TO for a run that isn't attributed to any environment.
	if (envIdNum !== null && auth.isEnterprise && !(await auth.canAccessEnvironment(envIdNum))) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	const stackName = decodeURIComponent(params.name);
	const { executions } = await getScheduleExecutions({
		scheduleType: 'stack_deploy',
		entityName: stackName,
		environmentId: envIdNum,
		limit: 100
	});

	return json({
		runs: executions.map((e) => ({
			id: e.id,
			environmentId: e.environmentId,
			triggeredBy: e.triggeredBy,
			triggeredAt: e.triggeredAt,
			startedAt: e.startedAt,
			completedAt: e.completedAt,
			duration: e.duration,
			status: e.status,
			errorMessage: e.errorMessage,
			details: e.details
		}))
	});
};
