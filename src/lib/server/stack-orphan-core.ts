/**
 * Which stack containers are dynamically-spawned orphans, not compose's own services.
 *
 * Pure, so it can be unit-tested without the database and crypto that stacks.ts pulls in.
 */

/**
 * A container "belongs to a stack" (carries com.docker.compose.project) but was NOT
 * created by compose from the compose file. Compose stamps every service it manages with
 * com.docker.compose.service; a child a service spawns itself through the Docker API (for
 * example a nextcloud-aio master creating worker containers) carries the project label but
 * not the service label. Only those are orphans the stack lifecycle has to stop/restart/
 * remove by hand - compose already handled its own services. Restarting a compose service
 * here after an up/recreate would needlessly bounce it (and, for a network_mode: service:X
 * dependent, kill it mid-startup).
 */
export function isDynamicallySpawnedOrphan(labels: Record<string, string> | undefined | null): boolean {
	const l = labels ?? {};
	return !l['com.docker.compose.service'];
}

/**
 * Whether cleanupOrphanStackContainers should act on a given stack container.
 *
 * The whole call-site decision, pure so it can be pinned by a unit test (stacks.ts cannot
 * import under bun). Only running/restarting containers are candidates. For 'restart' (the
 * recreate post-step) only orphans qualify - restarting a compose service compose just
 * recreated bounces a network_mode: service:X dependent mid-startup. 'stop'/'remove' sweep
 * every running container as a teardown safety net (a failed/partial compose down can leave
 * services running), and have no mid-startup concern.
 */
export function shouldCleanupStackContainer(
	operation: 'stop' | 'remove' | 'restart',
	state: string,
	labels: Record<string, string> | undefined | null
): boolean {
	if (state !== 'running' && state !== 'restarting') return false;
	if (operation === 'restart') return isDynamicallySpawnedOrphan(labels);
	return true;
}
