/**
 * Pure git-stack deploy decisions, extracted so they are unit-testable without the
 * I/O-heavy deployGitStack. A manual/one-off deploy (`force`) deploys but does NOT
 * force-recreate, so only shouldDeployGitStack takes it.
 */

/**
 * Whether to deploy at all. A manual/one-off deploy (`force`) or a real git change
 * always deploys; the "always redeploy on webhook/scheduled sync" setting forces a
 * deploy even when git reported no changes.
 *
 * `lastDeployFailed` deploys again after a deploy that failed. The commit is recorded
 * before the deploy runs, so without this the next run sees no git change and skips
 * forever, leaving the stack on the old version while it reports being in sync.
 */
export function shouldDeployGitStack(input: {
	force: boolean;
	forceRedeploy: boolean;
	gitUpdated: boolean;
	lastDeployFailed?: boolean;
}): boolean {
	return input.force || input.forceRedeploy || input.gitUpdated || !!input.lastDeployFailed;
}

/**
 * Whether to pass `--force-recreate`. A plain `docker compose up -d` already recreates
 * exactly the services whose configuration changed - a changed image, env value (from
 * `.env`, `.env.dockhand`, an `env_file:`, or a shell-env `${VAR}` secret), compose
 * field, or bind definition all move the service's config hash and trigger a recreate on
 * their own. So a git change does NOT need `--force-recreate`; forcing it recreated the
 * whole stack for a change that touched no service (e.g. a README in the stack dir),
 * which on a stack hosting its own agent abandoned the deploy mid-operation.
 *
 * It is kept for the two cases where a plain `up` would no-op but a recreate is wanted:
 * the "always redeploy" setting (an explicit opt-in to restart regardless of diff), and
 * a retry after a failed DEPLOY (git reports no change, yet the containers the failed
 * deploy never replaced must be recreated). A failed clone does not qualify - those
 * containers are in step.
 */
export function shouldForceRecreateGitStack(input: {
	forceRedeploy: boolean;
	lastDeployFailed?: boolean;
}): boolean {
	return input.forceRedeploy || !!input.lastDeployFailed;
}

/**
 * Prefix stamped on syncError when a DEPLOY failed, as opposed to the clone or
 * fetch that precedes it. `syncStatus: 'error'` alone cannot tell the two apart -
 * three places write it - and only a failed deploy leaves containers out of step
 * with the recorded commit.
 */
export const DEPLOY_FAILURE_PREFIX = 'Deploy failed: ';

/** Whether a stack's stored error came from a deploy rather than from the sync. */
export function isDeployFailure(syncStatus: string | null | undefined, syncError: string | null | undefined): boolean {
	return syncStatus === 'error' && typeof syncError === 'string' && syncError.startsWith(DEPLOY_FAILURE_PREFIX);
}

/**
 * The deploy + force-recreate decision for one git sync, from the full context, so the
 * rule "a git change deploys but does not force-recreate" is a behavioural unit test
 * rather than a source-text grep over the call site (git.ts cannot be imported under bun).
 * `gitUpdated` is deliberately absent from the force-recreate half.
 */
export function gitDeployDecision(input: {
	force: boolean;
	forceRedeploy: boolean;
	gitUpdated: boolean;
	lastDeployFailed?: boolean;
}): { deploy: boolean; forceRecreate: boolean } {
	return {
		deploy: shouldDeployGitStack(input),
		forceRecreate: shouldForceRecreateGitStack({
			forceRedeploy: input.forceRedeploy,
			lastDeployFailed: input.lastDeployFailed
		})
	};
}
