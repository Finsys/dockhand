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
/**
 * Statuses a stack_deploy run can be permanently closed under -- i.e. the deploy has
 * actually stopped running and nothing will update this row again on its own. Kept as
 * an explicit allow-list (not "everything except queued/running") on purpose: the
 * status column is free text (db.ts's ScheduleStatus comment), and a status this code
 * doesn't recognize must NOT be assumed finished just because it isn't literally
 * 'queued' or 'running' -- see isTerminalRunStatus()'s doc comment for what that
 * assumption would cost.
 *
 * This is deliberately its OWN small set, not deploy-log-reconcile-core.ts's
 * isEligibleForMissingMark() (which answers "queued"/"running" vs. everything else,
 * fail-open for an unrecognized status because marking logMissing is reversible and
 * merely metadata). Deleting a run is NOT reversible, so unlike that check, an
 * unrecognized status here must fail CLOSED (treated as still in progress), not open.
 */
const TERMINAL_RUN_STATUSES = new Set(['success', 'failed', 'skipped', 'warning', 'error', 'cancelled', 'stale']);

/**
 * Whether a stack_deploy run's status means the deploy is over and its record/log file
 * may safely be deleted.
 *
 * Fails CLOSED for anything not explicitly listed in TERMINAL_RUN_STATUSES -- including
 * 'queued', 'running', and any status this code has never been taught about (the status
 * column is free text). The alternative (terminal = "not queued/running") would let a
 * status this code doesn't recognize be deleted on the assumption that it must be
 * finished; there is no way to confirm that, and a wrong guess here is irreversible (see
 * loadOwnedDeployRun's DELETE caller in .../deploys/[runId]/+server.ts).
 */
export function isTerminalRunStatus(status: string): boolean {
	return TERMINAL_RUN_STATUSES.has(status);
}

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
