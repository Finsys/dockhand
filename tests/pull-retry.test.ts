import { describe, test, expect } from 'bun:test';
import { isTooManyRequests, retryAfterMs, withPullRetry, PULL_RETRY_DELAYS_MS } from '../src/lib/server/pull-retry';

// Error messages exactly as pullImage throws them, taken from GHCR rate-limit logs.
const STREAM = 'Failed to pull image: toomanyrequests: retry-after: 738.501µs, allowed: 44000/minute';
const CONFIG = 'Failed to pull image: error pulling image configuration: download failed after attempts=1: toomanyrequests: retry-after: 123.381µs, allowed: 44000/minute';
const BODY_429 = 'Failed to pull image: {"message":"toomanyrequests: You have reached your pull rate limit."}';

describe('isTooManyRequests', () => {
	test('a stream error, an image-config error and a 429 body are rate limits', () => {
		expect(isTooManyRequests(STREAM)).toBe(true);
		expect(isTooManyRequests(CONFIG)).toBe(true);
		expect(isTooManyRequests(BODY_429)).toBe(true);
		expect(isTooManyRequests('Failed to pull image: 429 Too Many Requests')).toBe(true);
	});

	test('other pull failures are not', () => {
		expect(isTooManyRequests('Failed to pull image: manifest unknown')).toBe(false);
		expect(isTooManyRequests('Failed to pull image: unauthorized: authentication required')).toBe(false);
		expect(isTooManyRequests('too many open files')).toBe(false);
	});
});

describe('retryAfterMs', () => {
	test('reads Go durations', () => {
		expect(retryAfterMs(STREAM)).toBeCloseTo(0.738501, 6);
		expect(retryAfterMs('toomanyrequests: retry-after: 2.5s')).toBe(2500);
		expect(retryAfterMs('toomanyrequests: retry-after: 1m30s')).toBe(90_000);
		expect(retryAfterMs('toomanyrequests: retry-after: 250ms, allowed: 1/s')).toBe(250);
		expect(retryAfterMs('toomanyrequests: retry-after:3s')).toBe(3000);
	});

	test('no retry-after, or one it cannot read, is null', () => {
		expect(retryAfterMs(BODY_429)).toBeNull();
		expect(retryAfterMs('retry-after: soon')).toBeNull();
		expect(retryAfterMs('retry-after: 2sx')).toBeNull();
	});
});

describe('withPullRetry', () => {
	function scripted(errors: (string | null)[]) {
		let calls = 0;
		const waits: number[] = [];
		const pull = async () => {
			const e = errors[calls++];
			if (e) throw new Error(e);
			return 'pulled';
		};
		return { pull, waits, sleep: async (ms: number) => { waits.push(ms); }, calls: () => calls };
	}

	test('a rate-limited pull is retried after the first step and then succeeds', async () => {
		const s = scripted([STREAM, null]);
		expect(await withPullRetry(s.pull, { sleep: s.sleep })).toBe('pulled');
		expect(s.calls()).toBe(2);
		expect(s.waits).toEqual([PULL_RETRY_DELAYS_MS[0]]);
	});

	test('a longer retry-after is waited out instead of the step, up to a minute', async () => {
		const s = scripted(['toomanyrequests: retry-after: 20s', 'toomanyrequests: retry-after: 10m', null]);
		await withPullRetry(s.pull, { sleep: s.sleep });
		expect(s.waits).toEqual([20_000, 60_000]);
	});

	test('it gives up after the last retry and throws the rate limit', async () => {
		const s = scripted([STREAM, STREAM, STREAM, STREAM, null]);
		await expect(withPullRetry(s.pull, { sleep: s.sleep })).rejects.toThrow('toomanyrequests');
		expect(s.calls()).toBe(PULL_RETRY_DELAYS_MS.length + 1);
		expect(s.waits).toEqual(PULL_RETRY_DELAYS_MS);
	});

	test('a rate limit thrown as a plain string is retried too', async () => {
		let calls = 0;
		const waits: number[] = [];
		const result = await withPullRetry(async () => {
			if (calls++ === 0) throw 'toomanyrequests: retry-after: 1us';
			return 'pulled';
		}, { sleep: async (ms) => { waits.push(ms); } });
		expect(result).toBe('pulled');
		expect(waits).toEqual([PULL_RETRY_DELAYS_MS[0]]);
	});

	test('any other error is thrown at once, without a retry', async () => {
		const s = scripted(['Failed to pull image: manifest unknown', null]);
		await expect(withPullRetry(s.pull, { sleep: s.sleep })).rejects.toThrow('manifest unknown');
		expect(s.calls()).toBe(1);
		expect(s.waits).toEqual([]);
	});

	test('each retry is logged', async () => {
		const s = scripted([STREAM, null]);
		const lines: string[] = [];
		await withPullRetry(s.pull, { sleep: s.sleep, log: (m) => lines.push(m) });
		expect(lines).toEqual(['Registry rate limit, retrying the pull in 1s (attempt 2 of 4)']);
	});
});

// The scheduler tasks load the database, which bun cannot, so this only pins that
// every scheduled pull goes through the retry.
describe('scheduled pulls go through withPullRetry', () => {
	const { readFileSync } = require('node:fs') as typeof import('node:fs');
	for (const file of ['env-update-check.ts', 'container-update.ts']) {
		test(file, () => {
			const src = readFileSync(new URL(`../src/lib/server/scheduler/tasks/${file}`, import.meta.url), 'utf8');
			const shape = file === 'container-update.ts'
				? /withPullRetry\(\(\) => pullImage\(imageNameFromConfig, undefined, envId, true\), \{ log \}\)/g
				: /withPullRetry\(\(\) => pullImage\(update\.imageName, \(\) => \{\}, environmentId, true\), \{ log: \(m\) => log\(`  \$\{m\}`\) \}\)/g;
			expect(src.match(shape)?.length).toBe(2);
			expect(src.match(/withPullRetry\(/g)?.length).toBe(2);
			expect(src.match(/await pullImage\(/g)).toBeNull();
		});
	}
});
