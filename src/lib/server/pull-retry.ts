/**
 * Retrying a registry check or an image pull that a registry rate-limited. GHCR
 * throttles around the full hour, when scheduled jobs everywhere start, and answers
 * with a retry-after of microseconds that says nothing about how long it lasts, so
 * the waits come from the backoff. Kept import-light so it can be unit-tested.
 */
import { RATE_LIMITED_PREFIX } from './registry-failure-core';
import { imageRegistryAuthority } from './scanner-registry-core';

/** Waits between attempts, in ms: GHCR's throttling outlasts seconds, so about 2.5 minutes in all. */
export const PULL_RETRY_DELAYS_MS = [15000, 45000, 90000];

/**
 * The default wait: each one gets up to a quarter more at random, so the per-container
 * jobs that one cron tick started do not all come back to the registry at once.
 */
const jitteredSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms + Math.random() * ms * 0.25));

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

/** A duration in a log line: milliseconds below a second, else seconds. */
function formatMs(ms: number): string {
	return ms < 1000 ? `${Number(ms.toPrecision(3))}ms` : `${Number((ms / 1000).toFixed(1))}s`;
}

/** How long to wait before the next attempt, and where that number came from, for the log. */
export function retryWait(message: string, delay: number): { wait: number; source: string } {
	const requested = retryAfterMs(message);
	if (requested === null) return { wait: delay, source: 'backoff' };
	if (requested > MAX_RETRY_AFTER_MS) {
		if (delay >= MAX_RETRY_AFTER_MS) return { wait: delay, source: `backoff, retry-after ${formatMs(requested)} is over the ${formatMs(MAX_RETRY_AFTER_MS)} cap` };
		return { wait: MAX_RETRY_AFTER_MS, source: `retry-after ${formatMs(requested)}, capped at ${formatMs(MAX_RETRY_AFTER_MS)}` };
	}
	if (requested > delay) return { wait: requested, source: `retry-after ${formatMs(requested)}` };
	return { wait: delay, source: `backoff, retry-after ${formatMs(requested)} is shorter` };
}

/**
 * Run a pull, retrying it while the registry rate-limits it. Each wait is the
 * backoff step, or the registry's retry-after when that is longer. Any other error,
 * or a rate limit after the last retry, is thrown as it came. `label` names the pull
 * in the log lines (container, image, environment).
 */
export async function withPullRetry<T>(
	pull: () => Promise<T>,
	opts: { delays?: number[]; sleep?: (ms: number) => Promise<void>; log?: (message: string) => unknown; label?: string } = {}
): Promise<T> {
	const { delays = PULL_RETRY_DELAYS_MS, sleep = jitteredSleep, log, label } = opts;
	const on = label ? ` on ${label}` : '';
	const say = async (line: string) => {
		try {
			await log?.(line);
		} catch {
			// A log write that fails never changes the outcome of the pull.
		}
	};
	for (let attempt = 0; ; attempt++) {
		try {
			return await pull();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!isTooManyRequests(message)) throw error;
			if (attempt >= delays.length) {
				await say(delays.length
					? `Registry rate limit${on}: giving up after ${delays.length + 1} attempts`
					: `Registry rate limit${on}: the registry kept refusing earlier in this run, not retrying the pull`);
				throw error;
			}
			const { wait, source } = retryWait(message, delays[attempt]);
			await say(`Registry rate limit${on}, retrying the pull in ${Math.round(wait / 1000)}s (${source}; attempt ${attempt + 2} of ${delays.length + 1})`);
			await sleep(wait);
		}
	}
}

/** Whether a registry check failed because the registry rate limited it, also inside a wrapping message. */
export function isRateLimitedCheck(error: string | null | undefined): boolean {
	return !!error?.includes(RATE_LIMITED_PREFIX);
}

/** The Retry-After a rate-limited check reports ("retry after 3600s", or an HTTP date), in ms, or null. */
export function checkRetryAfterMs(error: string, now: number = Date.now()): number | null {
	const value = error.match(/retry after ([^)]+)\)/)?.[1]?.trim();
	if (!value) return null;
	const seconds = value.match(/^(\d+)s$/)?.[1];
	if (seconds) return Number(seconds) * 1000;
	const at = Date.parse(value);
	return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/**
 * Run a registry check, running it again while the registry rate-limits it, with the
 * same backoff as a pull. A registry that asks to wait longer than the longest
 * honoured retry-after is not retried. The last result is returned as it came.
 */
export async function withCheckRetry<T extends { error?: string }>(
	check: () => Promise<T>,
	opts: { delays?: number[]; sleep?: (ms: number) => Promise<void>; log?: (message: string) => unknown; label?: string } = {}
): Promise<T> {
	const { delays = PULL_RETRY_DELAYS_MS, sleep = jitteredSleep, log, label } = opts;
	const on = label ? ` on ${label}` : '';
	const say = async (line: string) => {
		try {
			await log?.(line);
		} catch {
			// A log write that fails never changes the outcome of the check.
		}
	};
	for (let attempt = 0; ; attempt++) {
		const result = await check();
		if (!isRateLimitedCheck(result.error)) return result;
		const requested = checkRetryAfterMs(result.error!);
		if (requested !== null && requested > MAX_RETRY_AFTER_MS) {
			await say(`Registry rate limit${on}: the registry asks to wait ${Math.round(requested / 1000)}s, not retrying the check`);
			return result;
		}
		if (attempt >= delays.length) {
			await say(delays.length
				? `Registry rate limit${on}: giving up the check after ${delays.length + 1} attempts`
				: `Registry rate limit${on}: the registry kept refusing earlier in this run, not retrying the check`);
			return result;
		}
		const wait = Math.max(delays[attempt], requested ?? 0);
		await say(`Registry rate limit${on}, checking again in ${Math.round(wait / 1000)}s (attempt ${attempt + 2} of ${delays.length + 1})`);
		await sleep(wait);
	}
}

/**
 * The registries that rate limited a check or a pull through every retry in one run.
 * A run checks its images one after another, so a throttled registry would otherwise
 * add the whole backoff for each of its images; later images from it get one attempt,
 * until a check or pull from it gets through and its retries come back.
 */
export function createRegistryThrottle() {
	const throttled = new Set<string>();
	const registryOf = (image: string) => imageRegistryAuthority(image) ?? 'docker.io';
	return {
		/** The waits for an image: none once its registry kept refusing in this run. */
		delays: (image: string): number[] => (throttled.has(registryOf(image)) ? [] : PULL_RETRY_DELAYS_MS),
		isThrottled: (image: string): boolean => throttled.has(registryOf(image)),
		/** A check that came back rate limited marks its registry; one that got an answer clears it. */
		noteCheck: (image: string, error: string | null | undefined): void => {
			if (isRateLimitedCheck(error)) throttled.add(registryOf(image));
			else throttled.delete(registryOf(image));
		},
		/** A pull that failed rate limited marks its registry; a pull that worked (null) clears it. */
		notePull: (image: string, error: unknown): void => {
			if (error == null) throttled.delete(registryOf(image));
			else if (isTooManyRequests(error instanceof Error ? error.message : String(error))) throttled.add(registryOf(image));
		}
	};
}
