/**
 * Retrying an image pull that a registry rate-limited. GHCR answers a burst with
 * `toomanyrequests: retry-after: 123.381us` and the next attempt gets through, so a
 * scheduled update retries a few times before it reports the pull as failed.
 * Kept import-light so it can be unit-tested.
 */

/** Waits between attempts, in ms: one retry almost at once, then longer ones. */
export const PULL_RETRY_DELAYS_MS = [1000, 5000, 15000];

/** Longest retry-after honoured; a registry asking for more is not waited out. */
const MAX_RETRY_AFTER_MS = 60_000;

/** Whether a pull error is a registry rate limit (a stream error line, or a 429 body). */
export function isTooManyRequests(message: string): boolean {
	return /toomanyrequests|too many requests/i.test(message);
}

const UNIT_MS: Record<string, number> = { ns: 1e-6, us: 1e-3, 'µs': 1e-3, 'μs': 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** The `retry-after` in a registry error, in ms, read as a Go duration ("738.5us", "2s", "1m30s"). */
export function retryAfterMs(message: string): number | null {
	const value = message.match(/retry-after:\s*([0-9.a-zµμ]+)/i)?.[1];
	if (!value) return null;
	const parts = [...value.matchAll(/([0-9]*\.?[0-9]+)(ns|us|µs|μs|ms|s|m|h)/g)];
	if (!parts.length || parts.map((p) => p[0]).join('') !== value) return null;
	return parts.reduce((ms, [, n, unit]) => ms + Number(n) * UNIT_MS[unit], 0);
}

/**
 * Run a pull, retrying it while the registry rate-limits it. Each wait is the
 * backoff step, or the registry's retry-after when that is longer. Any other error,
 * or a rate limit after the last retry, is thrown as it came.
 */
export async function withPullRetry<T>(
	pull: () => Promise<T>,
	opts: { delays?: number[]; sleep?: (ms: number) => Promise<void>; log?: (message: string) => void } = {}
): Promise<T> {
	const { delays = PULL_RETRY_DELAYS_MS, sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)), log } = opts;
	for (let attempt = 0; ; attempt++) {
		try {
			return await pull();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (attempt >= delays.length || !isTooManyRequests(message)) throw error;
			const wait = Math.max(delays[attempt], Math.min(retryAfterMs(message) ?? 0, MAX_RETRY_AFTER_MS));
			log?.(`Registry rate limit, retrying the pull in ${Math.round(wait / 1000)}s (attempt ${attempt + 2} of ${delays.length + 1})`);
			await sleep(wait);
		}
	}
}
