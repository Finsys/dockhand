/**
 * Budgets for the dashboard's per-environment Docker listings.
 *
 * The environments tiles decide a host is "offline" from a listing timeout, but a
 * listing is the most expensive thing Dockhand asks a daemon for: on a busy host
 * (measured on 2 vCPU, ~50 containers) `containers/json` came back in 3-28s while
 * /_ping stayed under 5ms and `docker images` alone took 3.3s. With a flat 10s
 * budget the tile flipped to "Connection timeout" for a host that was up and
 * answering, then looked fine again on the next poll.
 *
 * So: a listing timeout is only a reason to go offline when the host also fails a
 * cheap ping. Operators on slow hardware can raise the budget with
 * DASHBOARD_TIMEOUT_MS (milliseconds).
 */

export const DEFAULT_LIST_TIMEOUT_MS = 10_000;

/** Parse a positive millisecond budget, falling back on anything unusable. */
export function parseTimeoutMs(raw: string | undefined | null, fallback: number): number {
	if (!raw) return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.floor(parsed);
}

export const LIST_TIMEOUT_MS = parseTimeoutMs(process.env.DASHBOARD_TIMEOUT_MS, DEFAULT_LIST_TIMEOUT_MS);

export interface ContainerProbeOutcome {
	online: boolean;
	error: string | null;
}

/**
 * Tile state after the container listing timed out: alive-but-slow stays online so
 * the tile keeps its last known counts instead of claiming the host is gone.
 */
export function outcomeAfterContainerTimeout(pingSucceeded: boolean, timeoutMs: number): ContainerProbeOutcome {
	if (pingSucceeded) {
		return {
			online: true,
			error: `Slow response: the container list took longer than ${Math.round(timeoutMs / 1000)}s`
		};
	}
	return { online: false, error: 'Connection timeout' };
}
