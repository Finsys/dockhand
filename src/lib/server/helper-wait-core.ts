/**
 * Pure deadline policy for waiting on a helper container's exit (runContainerWithStreaming
 * POLL mode). Kept import-light so it unit-tests under the bun runner - docker.ts pulls
 * better-sqlite3 transitively and can't load there.
 *
 * The rule: a POSITIVE timeout caps the wait; anything else (0 or undefined) is UNBOUNDED.
 * There is deliberately NO hidden default cap - the backup helper passes 0 on purpose (a
 * large backup legitimately runs for hours, bounded by manual cancel + the reaper, not a
 * wall clock - #1382). The old `timeout || 3_600_000` turned "unbounded" into 60 minutes
 * and force-killed healthy backups mid-run.
 */

/**
 * The cap in ms for a helper wait: the caller's timeout when positive, else 0 (=unbounded).
 * Returned separately from the deadline so callers/tests can reason about "is this capped".
 */
export function helperWaitCapMs(timeout: number | undefined): number {
	return timeout && timeout > 0 ? timeout : 0;
}

/**
 * The absolute deadline (ms epoch) for a helper wait given the caller's timeout and the
 * current time. `Infinity` means unbounded (poll until the container exits or is removed).
 */
export function helperWaitDeadline(timeout: number | undefined, now: number): number {
	const cap = helperWaitCapMs(timeout);
	return cap > 0 ? now + cap : Infinity;
}
