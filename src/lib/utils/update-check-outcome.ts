/**
 * The headline of a manual update check that found nothing to update. Failed checks
 * must not read as "all up to date": when every checkable container failed, the check
 * itself failed; when some did, only the rest are known to be current.
 */
export type NoUpdatesOutcome =
	| { status: 'none'; headline: 'all-current' | 'rest-current' | 'cooling-down' }
	| { status: 'error'; headline: 'all-failed' };

export function noUpdatesOutcome(failed: number, checkable: number, deferred: number): NoUpdatesOutcome {
	if (failed > 0 && failed >= checkable) return { status: 'error', headline: 'all-failed' };
	if (deferred > 0) return { status: 'none', headline: 'cooling-down' };
	return { status: 'none', headline: failed > 0 ? 'rest-current' : 'all-current' };
}

export interface CheckResultFlags {
	error?: unknown;
	hasUpdate?: boolean;
	systemContainer?: unknown;
	updateDisabled?: boolean;
	isLocalImage?: boolean;
}

/**
 * The checkable containers and how many of them failed. Both counts cover the same
 * set, so a failed check of a system container (Dockhand, Hawser) cannot turn a check
 * of healthy user containers into "every check failed".
 */
export function checkableCounts(results: CheckResultFlags[]): { checkable: number; failed: number } {
	const checkable = results.filter((r) => !r.systemContainer && !r.updateDisabled && !r.isLocalImage);
	return { checkable: checkable.length, failed: checkable.filter((r) => r.error && !r.hasUpdate).length };
}

/**
 * The results a page reports: only the containers it lists, so the stacks page does
 * not count an update on a container that belongs to no stack. No scope keeps all.
 */
export function resultsInScope<T extends { containerId: string }>(results: T[], containerIds?: Set<string>): T[] {
	return containerIds ? results.filter((r) => containerIds.has(r.containerId)) : results;
}

export interface UpdateCheckResultItem {
	containerId: string;
	containerName: string;
	imageName: string;
}

/**
 * A container running `repo:tag@sha256:...` whose tag now resolves to a different
 * digest. Reported, never applied: pulling that reference returns the pinned manifest,
 * so the digest in the user's compose is what has to change.
 */
export interface PinnedDigestItem {
	containerId: string;
	containerName: string;
	imageName: string;
	newDigest?: string;
}

/** A container that has a newer VERSION tag (semver) - independent of digest updates. */
export interface NewerVersionItem<V = unknown> {
	containerId: string;
	newerVersion: V;
}

export interface FailedCheckItem {
	containerId: string;
	containerName: string;
	imageName: string;
	error: string;
}

export interface CheckResult<V = unknown> extends CheckResultFlags {
	containerId: string;
	containerName: string;
	imageName: string;
	pinnedToDigest?: boolean;
	newDigest?: string;
	error?: string;
	releaseAgeRemainingHours?: number;
	newerVersion?: V | null;
}

/**
 * What a manual update check found among the containers in scope: the applicable
 * updates, the pinned digest moves, the failures, the updates held by the minimum
 * image age and the newer version tags.
 */
export function summarizeCheck<V>(all: CheckResult<V>[], containerIds?: Set<string>) {
	const results = resultsInScope(all, containerIds);
	const managed = (r: CheckResult<V>) => !r.systemContainer && !r.updateDisabled;
	// A `repo:tag@sha256:...` image is left out of the updatable set on purpose:
	// pulling that reference returns the pinned manifest, so the move is reported
	// and the digest in the user's compose is theirs to replace.
	const withUpdates: UpdateCheckResultItem[] = results
		.filter((r) => r.hasUpdate && !r.pinnedToDigest && managed(r) && !r.isLocalImage)
		.map((r) => ({ containerId: r.containerId, containerName: r.containerName, imageName: r.imageName }));
	const pinned: PinnedDigestItem[] = results
		.filter((r) => r.hasUpdate && r.pinnedToDigest && managed(r))
		.map((r) => ({ containerId: r.containerId, containerName: r.containerName, imageName: r.imageName, newDigest: r.newDigest }));
	const failed: FailedCheckItem[] = results
		.filter((r) => r.error && !r.hasUpdate)
		.map((r) => ({ containerId: r.containerId, containerName: r.containerName, imageName: r.imageName, error: r.error! }));
	const deferred = results.filter((r) => r.releaseAgeRemainingHours && managed(r));
	// Semver suggestions are independent of digest updates: a container can be
	// digest-current yet run an outdated version tag.
	const newerVersions: NewerVersionItem<V>[] = results
		.filter((r) => r.newerVersion && managed(r))
		.map((r) => ({ containerId: r.containerId, newerVersion: r.newerVersion as V }));
	return { withUpdates, pinned, failed, deferred, newerVersions, counts: checkableCounts(results) };
}
