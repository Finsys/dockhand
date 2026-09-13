/**
 * Pure git-stack deploy decisions, extracted so they are unit-testable without the
 * I/O-heavy deployGitStack. A manual/one-off deploy (`force`) deploys but does NOT
 * force-recreate, so only shouldDeployGitStack takes it.
 */

/**
 * Whether to deploy at all. A manual/one-off deploy (`force`) or a real git change
 * always deploys; the "always redeploy on webhook/scheduled sync" setting forces a
 * deploy even when git reported no changes.
 */
export function shouldDeployGitStack(input: {
	force: boolean;
	forceRedeploy: boolean;
	gitUpdated: boolean;
}): boolean {
	return input.force || input.forceRedeploy || input.gitUpdated;
}

/**
 * Whether to pass `--force-recreate`. Recreate on a real git change OR when the user
 * enabled "always redeploy": that setting exists to force the container back in step
 * with its configuration (a changed env var, secret, or rebound provider leaves no git
 * diff), and a plain `up` without --force-recreate would no-op and never re-inject the
 * shell-env secrets (#1523). Default (setting off, no git change) does NOT recreate, so
 * an ordinary sync never causes a surprise recreate.
 */
export function shouldForceRecreateGitStack(input: {
	forceRedeploy: boolean;
	gitUpdated: boolean;
}): boolean {
	return input.gitUpdated || input.forceRedeploy;
}
