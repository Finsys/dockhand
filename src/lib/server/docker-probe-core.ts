/**
 * Pure helper functions for Docker offline error handling and probe detection (#1739).
 * Extracted so they can be unit-tested without pulling in database and crypto dependencies.
 */

/**
 * Identifies lightweight probing or health-check endpoints where connection failures
 * are expected when a remote host is offline or booting.
 */
export function isDockerProbePath(path: string): boolean {
	const clean = path.split('?')[0];
	return clean === '/_ping' || clean === '/version' || clean === '/_hawser/info';
}

/**
 * Checks whether an error is a network unreachable/timeout/refused failure.
 */
export function isDockerNetworkError(error: unknown): boolean {
	const str = String(error);
	return (
		str.includes('fetch failed') ||
		str.includes('ECONNREFUSED') ||
		str.includes('ETIMEDOUT') ||
		str.includes('EHOSTUNREACH') ||
		str.includes('ENOTFOUND') ||
		str.includes('ECONNRESET') ||
		str.includes('Connection timeout') ||
		str.includes('Timeout') ||
		str.includes('timeout')
	);
}
