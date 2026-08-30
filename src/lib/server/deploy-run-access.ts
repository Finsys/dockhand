import { json } from '@sveltejs/kit';
import { getScheduleExecution, type ScheduleExecutionData } from './db';
import type { AuthorizationContext } from './authorize';

/**
 * Loads a schedule_executions row and confirms it actually belongs to the named
 * stack before deciding whether the caller may reach it.
 *
 * Two checks, deliberately in this order:
 *
 * 1. Ownership -- the row must be a 'stack_deploy' execution whose entityName
 *    matches the stack in the URL. A run for a DIFFERENT stack (or a
 *    non-deploy schedule execution that happens to reuse the same numeric id
 *    space) comes back as the exact same 404 as a run that doesn't exist at
 *    all. A distinct response for "wrong stack" vs "no such run" would leak
 *    that the id is valid for something else.
 *
 * 2. Environment access -- checked against the RUN's OWN environmentId, never
 *    against a caller-supplied `env` query parameter. A caller could otherwise
 *    pass an env they legitimately have access to while pointing runId at a
 *    run that actually belongs to a DIFFERENT environment they have no access
 *    to at all -- the same cross-env bypass class the backup routes' own
 *    route-guards.ts closes for snapshot/config lookups (resolveSnapshotEnvId
 *    + guardSnapshotEnvAccess). Fails closed: enterprise + inaccessible env
 *    denies, even if that hides an otherwise-existing run.
 *
 * Shared by GET and DELETE .../deploys/{runId} AND GET .../deploys/{runId}/log
 * so the three routes can never drift into checking different things for the
 * same row. The stacks:view/stacks:edit permission gate itself is NOT part of
 * this helper -- each route checks that on its own, inline, before calling
 * this (see the three +server.ts files).
 */
export async function loadOwnedDeployRun(
	stackName: string,
	runIdParam: string,
	auth: AuthorizationContext
): Promise<{ run: ScheduleExecutionData } | { response: Response }> {
	const runId = parseInt(runIdParam, 10);
	if (isNaN(runId)) {
		return { response: json({ error: 'Invalid run id' }, { status: 400 }) };
	}

	const run = await getScheduleExecution(runId);
	if (!run || run.scheduleType !== 'stack_deploy' || run.entityName !== stackName) {
		return { response: json({ error: 'Deploy run not found' }, { status: 404 }) };
	}

	if (run.environmentId != null && auth.isEnterprise && !(await auth.canAccessEnvironment(run.environmentId))) {
		return { response: json({ error: 'Access denied to this environment' }, { status: 403 }) };
	}

	return { run };
}
