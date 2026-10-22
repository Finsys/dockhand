/**
 * Operator-tunable timeouts for the provider CLIs we spawn.
 *
 * A CLI login is one network round-trip on a healthy host, so the defaults are
 * generous already; the override exists for the host where it is not, because the
 * alternative is waiting for a release to deploy a stack.
 */

/** The largest delay setTimeout accepts; beyond it the timer fires after 1ms. */
export const MAX_TIMER_MS = 2_147_483_647;

/** A timeout read from the environment, falling back to the built-in default. */
export function cliTimeoutMs(raw: string | undefined, fallbackMs: number): number {
	// Floored BEFORE the check: a fractional value under 1ms would otherwise pass
	// as positive and then floor to zero, firing the timer on the next tick.
	const parsed = Math.floor(Number((raw ?? '').trim()));
	// A zero, a negative or a typo would disable the bound that stops a hung CLI
	// holding the queue, so anything unusable keeps the default.
	if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
	// An operator reaching for "effectively unlimited" would otherwise get a 1ms
	// timer, failing every call instantly - the opposite of what they asked for.
	return Math.min(parsed, MAX_TIMER_MS);
}

/**
 * The message for a CLI that ran out of time, naming the phase that hung and the
 * variable that raises its limit. The phase is the whole diagnosis: a login that
 * hangs is a network or credential problem, a lookup that hangs is a slow vault.
 */
export function cliTimeoutMessage(
	provider: string,
	phase: string,
	timeoutMs: number,
	envVar: string
): string {
	const seconds = Math.round(timeoutMs / 100) / 10;
	return (
		`${provider} ${phase} timed out after ${seconds}s. ` +
		`If this host is legitimately slower, raise ${envVar} (milliseconds).`
	);
}
