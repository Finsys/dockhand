/**
 * Idle-timeout policy for Docker API requests over http/https. Import-light + pure so it's
 * unit-testable. Returns the socket idle timeout in ms, or null for NO timeout.
 *
 * A request whose BODY is a stream (a multi-GB tar PUT to /archive) must NOT get the 30s
 * small-request idle timeout: it can legitimately stall >30s (slow disk read, mTLS
 * backpressure, a GC pause) without being dead, and a 30s timer would destroy the transfer
 * mid-upload leaving the helper a truncated tar. This is independent of how the RESPONSE is
 * read (the response is tiny): body streaming and response streaming are tracked separately.
 */
export interface RequestTimeoutInput {
	/** The request path (used to bump compose / prune to longer timeouts). */
	path: string;
	/** True when the request body is a stream (large upload) - suppresses the idle timeout. */
	streamingBody: boolean;
	/** True when the RESPONSE is consumed as a stream (logs/events follow) - also no timeout. */
	streamingResponse: boolean;
	/** COMPOSE_TIMEOUT env, seconds; defaults to 900. */
	composeTimeoutSecs?: number;
	/**
	 * The container's own stop timeout in seconds, when the request is a stop or a
	 * restart and the container declares one (compose's `stop_grace_period` lands here
	 * as Config.StopTimeout). Docker only answers once the container is gone or that
	 * long has passed, so a shorter request timeout aborts a stop that is still legal.
	 */
	stopTimeoutSecs?: number | null;
	/** DOCKER_STOP_TIMEOUT env, seconds: a floor for containers that declare nothing. */
	stopEnvSecs?: number | null;
}

/** How long after the container's own deadline we still wait for the daemon to answer. */
export const STOP_TIMEOUT_MARGIN_MS = 15000;

/**
 * A stop or a restart: the daemon holds the response for the container's grace period.
 * The query string carries `?t=`, so match on the path alone.
 */
export function isStopPath(path: string): boolean {
	const p = path.split('?')[0];
	return p.endsWith('/stop') || p.endsWith('/restart');
}

/**
 * The request timeout for a stop/restart, in ms: the container's own grace period plus a
 * margin, never below the 30s every other request gets. `envOverrideSecs` is
 * DOCKER_STOP_TIMEOUT, a floor for a container that shuts down slowly without declaring
 * a grace period - it raises the wait, it never cuts one short.
 */
export function stopTimeoutMs(
	stopTimeoutSecs: number | null | undefined,
	envOverrideSecs?: number | null
): number {
	const declared =
		typeof stopTimeoutSecs === 'number' && Number.isFinite(stopTimeoutSecs) && stopTimeoutSecs > 0
			? stopTimeoutSecs * 1000 + STOP_TIMEOUT_MARGIN_MS
			: 0;
	const floor =
		typeof envOverrideSecs === 'number' && Number.isFinite(envOverrideSecs) && envOverrideSecs > 0
			? envOverrideSecs * 1000
			: 0;
	return Math.max(30000, declared, floor);
}

/** Prune endpoints get the long timeout; the query string (image prune filters) is ignored. #1630 */
export function isPrunePath(path: string): boolean {
	return path.split('?')[0].endsWith('/prune');
}

export function computeRequestTimeoutMs(input: RequestTimeoutInput): number | null {
	// No idle timeout when either end streams: a large body upload or a long-lived response.
	if (input.streamingBody || input.streamingResponse) return null;
	if (input.path === '/_hawser/compose') return (input.composeTimeoutSecs ?? 900) * 1000;
	if (isPrunePath(input.path)) return 300000;
	if (isStopPath(input.path)) return stopTimeoutMs(input.stopTimeoutSecs, input.stopEnvSecs);
	return 30000;
}
