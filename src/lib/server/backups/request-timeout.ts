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
}

export function computeRequestTimeoutMs(input: RequestTimeoutInput): number | null {
	// No idle timeout when either end streams: a large body upload or a long-lived response.
	if (input.streamingBody || input.streamingResponse) return null;
	if (input.path === '/_hawser/compose') return (input.composeTimeoutSecs ?? 900) * 1000;
	if (input.path.endsWith('/prune')) return 300000;
	return 30000;
}
