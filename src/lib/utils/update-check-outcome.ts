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
