/**
 * Which Docker API failures are worth an error in the log.
 *
 * Pure, so it can be unit-tested without pulling in the database and crypto that
 * `docker.ts` imports.
 */

/**
 * A lightweight reachability probe. A failure here carries no information a reader does
 * not already have from the environment's own offline status, and it repeats every
 * collection cycle.
 */
export function isDockerProbePath(path: string): boolean {
	const clean = path.split('?')[0];
	return clean === '/_ping' || clean === '/version' || clean === '/_hawser/info';
}

/**
 * Whether an error means "the host could not be reached", as opposed to the host
 * answering with a refusal.
 *
 * Matched on the errno code, never on the word "timeout" appearing somewhere in the
 * message: a stop timeout, a restic lock timeout and an exec timeout all contain it and
 * none of them is a network failure. A silent host produces no errno at all - the request
 * is cut short by `AbortSignal.timeout`, which raises a `TimeoutError` - so that is
 * matched by NAME.
 */
export function isExpectedConnectionError(error: unknown): boolean {
	if (error && typeof error === 'object' && (error as { name?: string }).name === 'TimeoutError') {
		return true;
	}
	const message = (error as { message?: string })?.message ?? String(error);
	return /not connected|offline|unreachable|fetch failed|EPROTO|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND/i.test(message);
}

/**
 * Whether a failed request should be logged as an error.
 *
 * A request that could not reach the host is quiet whatever the path: the collector
 * already reports the online->offline transition once (with a notification and
 * env_up=0), so the per-cycle unreachable failures on /containers/json, /images/json,
 * /volumes and /networks add nothing and just flood the log. A failure for any OTHER
 * reason - a bad token, an expired certificate, a refusal - is still an error, because
 * the host answered and that needs acting on.
 */
export function isQuietDockerFailure(_path: string, error: unknown): boolean {
	return isExpectedConnectionError(error);
}

/**
 * A timeout or abort synthesised by a transport, rather than reported by the socket.
 *
 * The HTTPS agent and the edge relay both cut a request short themselves, so the errno
 * the socket would have carried is gone. Naming the error is what lets one predicate
 * recognise an unreachable host on every transport instead of only on plain HTTP, where
 * `fetch` supplies a `TimeoutError` of its own.
 */
export function transportTimeoutError(message: string): Error {
	const error = new Error(message);
	error.name = 'TimeoutError';
	return error;
}
