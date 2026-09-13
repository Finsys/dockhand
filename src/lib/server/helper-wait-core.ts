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

/** The subset of Docker's container State the exit classifier reads. */
export interface HelperContainerState {
	Status?: string;
	Running?: boolean;
	ExitCode?: number;
	Error?: string;
}

/**
 * The definitive exit code for a helper container's State, or undefined when the
 * container is not yet in a terminal state (still creating/running -> keep waiting).
 *
 * A normal helper goes created -> running -> `exited`. But the daemon can also leave a
 * container that FAILED TO START in a terminal `created` (or `dead`) state with a
 * non-zero ExitCode and a State.Error - e.g. Docker 29.x / containerd leaving exit 128
 * "failed to mount overlay: device or resource busy" (#1487). That is terminal too: the
 * container will never run, so its exit code must be resolved (fail-closed) instead of
 * the poll loop waiting on an `exited` status that never arrives.
 *
 * A brand-new `created` container that is about to start (ExitCode 0, no Error) is NOT
 * terminal - runContainerWithStreaming calls /start before polling, so a `created` seen
 * with a non-zero ExitCode or an Error is a genuine start failure, not a pre-start race.
 */
export function helperExitFromState(state: HelperContainerState | undefined | null): number | undefined {
	if (!state || state.Running !== false || typeof state.ExitCode !== 'number') return undefined;
	if (state.Status === 'exited') return state.ExitCode;
	if ((state.Status === 'created' || state.Status === 'dead') && (state.ExitCode !== 0 || !!state.Error)) {
		return state.ExitCode;
	}
	return undefined;
}
