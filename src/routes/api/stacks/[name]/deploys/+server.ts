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
 * `env` is REQUIRED, unlike the other two routes under .../deploys (which
 * derive the environment from the loaded run itself via loadOwnedDeployRun).
 * A stack NAME alone is not unique -- the same name can exist in more than
 * one environment -- so a list without `env` would either merge runs from
 * unrelated environments into one response, or (as it did before this was a
 * hard 400) get evaluated against the caller's globally-merged permission
 * instead of their permission for one specific environment: `auth.can(...,
 * undefined)` checks the OR of every role's grant across all environments,
 * not "does this caller have stacks:view for env X". A caller with
 * stacks:view scoped to exactly one environment could omit `env` and get
 * runs -- including timestamps, status, error text and details.userId --
 * from every environment that happens to have a same-named stack. Requiring
 * `env` up front closes that: parsing happens before the permission check,
 * so `can()` and `canAccessEnvironment()` always see a definite id, never
 * undefined.
 */
/**
 * @openapi
 * summary: List deploy runs recorded for a stack (no log text -- see GET .../{runId}/log)
 * path: name:string! Stack name (from GET /api/stacks)
 * query: env:integer! Environment id the stack belongs to (from GET /api/environments)
 * resp-200: {runs:array<{id:integer!, environmentId:integer, triggeredBy:string!, triggeredAt:string!, startedAt:string, completedAt:string, duration:integer, status:string!, errorMessage:string, details:{}}>!}
 * resp-400: env query parameter is required
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

	// env is mandatory (see the module doc comment above for why) and is
	// parsed BEFORE the permission check below, so `can()` never falls back to
	// the caller's globally-merged permission across all environments.
	const envIdParam = url.searchParams.get('env');
	const envIdNum = envIdParam !== null ? parseInt(envIdParam, 10) : NaN;
	if (envIdParam === null || isNaN(envIdNum)) {
		return json({ error: 'env query parameter is required' }, { status: 400 });
	}

	if (auth.authEnabled && !(await auth.can('stacks', 'view', envIdNum))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	if (auth.isEnterprise && !(await auth.canAccessEnvironment(envIdNum))) {
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
