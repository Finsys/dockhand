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
 */
/**
 * @openapi
 * summary: List deploy runs recorded for a stack (no log text -- see GET .../{runId}/log)
 * path: name:string! Stack name (from GET /api/stacks)
 * query: env:integer Environment id the stack belongs to (from GET /api/environments)
 * resp-200: {runs:array<{id:integer!, environmentId:integer, triggeredBy:string!, triggeredAt:string!, startedAt:string, completedAt:string, duration:integer, status:string!, errorMessage:string, details:{}}>!}
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

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	if (auth.authEnabled && !(await auth.can('stacks', 'view', envIdNum))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	if (envIdNum !== undefined && auth.isEnterprise && !(await auth.canAccessEnvironment(envIdNum))) {
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
