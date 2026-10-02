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
 * Whether to pass `--force-recreate`. Recreate on a real git change OR when the user
 * enabled "always redeploy": that setting exists to force the container back in step
 * with its configuration (a changed env var, secret, or rebound provider leaves no git
 * diff), and a plain `up` without --force-recreate would no-op and never re-inject the
 * shell-env secrets (#1523). Default (setting off, no git change) does NOT recreate, so
 * an ordinary sync never causes a surprise recreate.
 *
 * A retry after a failed DEPLOY recreates for the same reason: git reports no
 * change, so a plain `up` would no-op against containers the failed deploy never
 * replaced. A failed clone does not qualify - those containers are in step.
 */
export function shouldForceRecreateGitStack(input: {
	forceRedeploy: boolean;
	gitUpdated: boolean;
	lastDeployFailed?: boolean;
}): boolean {
	return input.gitUpdated || input.forceRedeploy || !!input.lastDeployFailed;
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
