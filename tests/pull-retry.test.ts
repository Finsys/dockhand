import { describe, test, expect } from 'bun:test';
import { isTooManyRequests, retryAfterMs, withPullRetry, retryWait, withCheckRetry, isRateLimitedCheck, createRegistryThrottle, checkRetryAfterMs, PULL_RETRY_DELAYS_MS } from '../src/lib/server/pull-retry';
import { describeRegistryFailure } from '../src/lib/server/registry-failure-core';

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

	test('each retry is logged with what was pulled and where the wait came from', async () => {
		const s = scripted([STREAM, null]);
		const lines: string[] = [];
		await withPullRetry(s.pull, { sleep: s.sleep, log: (m) => lines.push(m), label: 'web (ghcr.io/x/y:1), env 3' });
		expect(lines).toEqual(['Registry rate limit on web (ghcr.io/x/y:1), env 3, retrying the pull in 15s (backoff, retry-after 0.739ms is shorter; attempt 2 of 4)']);
	});

	test('giving up after the last retry is logged', async () => {
		const s = scripted([STREAM, STREAM, STREAM, STREAM]);
		const lines: string[] = [];
		await expect(withPullRetry(s.pull, { sleep: s.sleep, log: (m) => lines.push(m) })).rejects.toThrow('toomanyrequests');
		expect(lines.at(-1)).toBe('Registry rate limit: giving up after 4 attempts');
		expect(lines).toHaveLength(4);
	});

	test('an async log is awaited before the wait, so its lines stay in order', async () => {
		const s = scripted([STREAM, null]);
		const order: string[] = [];
		const log = async (m: string) => { await new Promise((r) => setTimeout(r, 5)); order.push(`logged: ${m.slice(0, 20)}`); };
		await withPullRetry(s.pull, { sleep: async (ms) => { order.push(`slept ${ms}`); }, log });
		expect(order).toEqual(['logged: Registry rate limit,', 'slept 15000']);
	});

	test('a log write that fails does not change the outcome', async () => {
		const ok = scripted([STREAM, null]);
		await expect(withPullRetry(ok.pull, { sleep: ok.sleep, log: async () => { throw new Error('db down'); } })).resolves.toBeDefined();
		expect(ok.calls()).toBe(2);
		const sync = scripted([STREAM, null]);
		await expect(withPullRetry(sync.pull, { sleep: sync.sleep, log: () => { throw new Error('db down'); } })).resolves.toBeDefined();
		const gaveUp = scripted([STREAM, STREAM, STREAM, STREAM]);
		await expect(withPullRetry(gaveUp.pull, { sleep: gaveUp.sleep, log: async () => { throw new Error('db down'); } })).rejects.toThrow('toomanyrequests');
	});

	test('a failure that is not a rate limit logs nothing', async () => {
		const s = scripted(['Failed to pull image: manifest unknown']);
		const lines: string[] = [];
		await expect(withPullRetry(s.pull, { sleep: s.sleep, log: (m) => lines.push(m) })).rejects.toThrow('manifest unknown');
		expect(lines).toEqual([]);
	});
});

describe('retryWait', () => {
	test('names where the wait came from', () => {
		expect(retryWait('toomanyrequests', 1000)).toEqual({ wait: 1000, source: 'backoff' });
		expect(retryWait('toomanyrequests: retry-after: 2.5s', 1000)).toEqual({ wait: 2500, source: 'retry-after 2.5s' });
		expect(retryWait('toomanyrequests: retry-after: 5m', 1000)).toEqual({ wait: 60_000, source: 'retry-after 300s, capped at 60s' });
		expect(retryWait(STREAM, 1000)).toEqual({ wait: 1000, source: 'backoff, retry-after 0.739ms is shorter' });
		expect(retryWait('toomanyrequests: retry-after: 5m', 90_000)).toEqual({ wait: 90_000, source: 'backoff, retry-after 300s is over the 60s cap' });
	});

	test('waits as long as max(backoff, min(retry-after, 60s))', () => {
		const messages = [STREAM, CONFIG, BODY_429, 'toomanyrequests: retry-after: 2.5s', 'toomanyrequests: retry-after: 5m', 'toomanyrequests: retry-after: 15s', 'toomanyrequests: retry-after: 60s'];
		for (const m of messages) for (const d of PULL_RETRY_DELAYS_MS) {
			expect(retryWait(m, d).wait).toBe(Math.max(d, Math.min(retryAfterMs(m) ?? 0, 60_000)));
		}
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
				? /withPullRetry\(\(\) => pullImage\(imageNameFromConfig, undefined, envId, true\), \{ log, label: `\$\{containerName\} \(\$\{imageNameFromConfig\}\)\$\{envId \? `, env \$\{envId\}` : ''\}` \}\)/g
				: /withPullRetry\(\(\) => pullImage\(update\.imageName, \(\) => \{\}, environmentId, true\), \{ log: \(m\) => log\(`  \$\{m\}`\), label: `\$\{update\.containerName\} \(\$\{update\.imageName\}\), env \$\{env\.name\}`, delays: throttle\.delays\(update\.imageName\) \}\)/g;
			expect(src.match(shape)?.length).toBe(2);
			expect(src.match(/withPullRetry\(/g)?.length).toBe(2);
			expect(src.match(/await pullImage\(/g)).toBeNull();
			// The registry check that decides on an update is retried on a 429 too.
			expect(src.match(/withCheckRetry\(\(\) => checkImageUpdateAvailable\(/g)?.length).toBe(1);
			expect(src.match(/checkImageUpdateAvailable\(/g)?.length).toBe(1);
		});
	}
});

// Exactly as checkImageUpdateAvailable reports a 429 inside the multi-arch check.
const CHECK_429 = 'Could not confirm whether the multi-arch image is current: Rate limited by registry (429)';

describe('backoff', () => {
	test('outlasts a GHCR throttle: about 2.5 minutes of waiting in all', () => {
		// GHCR keeps refusing for about 90 s after the full hour (a pull at :01:28 still got
		// a 429), so the waits together must outlast that.
		expect(PULL_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeGreaterThan(90_000);
		expect(PULL_RETRY_DELAYS_MS[0]).toBeGreaterThanOrEqual(15_000);
	});
});

describe('withCheckRetry', () => {
	function checks(errors: (string | undefined)[]) {
		let calls = 0;
		const waits: number[] = [];
		const check = async () => ({ hasUpdate: false, error: errors[Math.min(calls++, errors.length - 1)] });
		return { check, waits, sleep: async (ms: number) => { waits.push(ms); }, calls: () => calls };
	}

	test('recognises our 429 text, also wrapped, and nothing else', () => {
		expect(describeRegistryFailure({ kind: 'http', status: 429, retryAfter: null })).toBe('Rate limited by registry (429)');
		expect(isRateLimitedCheck(CHECK_429)).toBe(true);
		expect(isRateLimitedCheck('Rate limited by registry (429, retry after 30s)')).toBe(true);
		expect(isRateLimitedCheck('Registry returned 404 (image or tag not found - deleted upstream, private, or a locally built image)')).toBe(false);
		expect(isRateLimitedCheck('Registry server error (503)')).toBe(false);
		expect(isRateLimitedCheck(undefined)).toBe(false);
	});

	test('a rate-limited check runs again and its later answer is returned', async () => {
		const c = checks([CHECK_429, undefined]);
		const result = await withCheckRetry(c.check, { sleep: c.sleep });
		expect(result.error).toBeUndefined();
		expect(c.calls()).toBe(2);
		expect(c.waits).toEqual([PULL_RETRY_DELAYS_MS[0]]);
	});

	test('any other error is returned at once', async () => {
		const c = checks(['Registry server error (503)']);
		const result = await withCheckRetry(c.check, { sleep: c.sleep });
		expect(result.error).toBe('Registry server error (503)');
		expect(c.calls()).toBe(1);
	});

	test('gives up after the last attempt, logged, with the last result', async () => {
		const c = checks([CHECK_429]);
		const lines: string[] = [];
		const result = await withCheckRetry(c.check, { sleep: c.sleep, log: (m) => lines.push(m), label: 'duckdns (lscr.io/linuxserver/duckdns:latest)' });
		expect(result.error).toBe(CHECK_429);
		expect(c.calls()).toBe(PULL_RETRY_DELAYS_MS.length + 1);
		expect(c.waits).toEqual(PULL_RETRY_DELAYS_MS);
		expect(lines[0]).toBe('Registry rate limit on duckdns (lscr.io/linuxserver/duckdns:latest), checking again in 15s (attempt 2 of 4)');
		expect(lines.at(-1)).toBe('Registry rate limit on duckdns (lscr.io/linuxserver/duckdns:latest): giving up the check after 4 attempts');
	});

	test('a registry asking for longer than 60 s is not retried', async () => {
		const c = checks(['Rate limited by registry (429, retry after 3600s)']);
		const lines: string[] = [];
		await withCheckRetry(c.check, { sleep: c.sleep, log: (m) => lines.push(m) });
		expect(c.calls()).toBe(1);
		expect(lines).toEqual(['Registry rate limit: the registry asks to wait 3600s, not retrying the check']);
	});

	test('a shorter retry-after than the backoff waits the backoff, a longer one waits it out', async () => {
		const c = checks(['Rate limited by registry (429, retry after 40s)', undefined]);
		await withCheckRetry(c.check, { sleep: c.sleep });
		expect(c.waits).toEqual([40_000]);
		const short = checks(['Rate limited by registry (429, retry after 5s)', undefined]);
		await withCheckRetry(short.check, { sleep: short.sleep });
		expect(short.waits).toEqual([PULL_RETRY_DELAYS_MS[0]]);
	});

	test('a log write that fails does not change the outcome', async () => {
		const c = checks([CHECK_429, undefined]);
		const result = await withCheckRetry(c.check, { sleep: c.sleep, log: async () => { throw new Error('db down'); } });
		expect(result.error).toBeUndefined();
	});
});

describe('createRegistryThrottle', () => {
	test('a registry that kept refusing a check gets one attempt for its later images', () => {
		const t = createRegistryThrottle();
		expect(t.delays('lscr.io/linuxserver/duckdns:latest')).toEqual(PULL_RETRY_DELAYS_MS);
		t.noteCheck('lscr.io/linuxserver/duckdns:latest', CHECK_429);
		expect(t.delays('lscr.io/linuxserver/wireguard:latest')).toEqual([]);
		expect(t.isThrottled('lscr.io/linuxserver/wireguard:latest')).toBe(true);
	});

	test('other registries, Docker Hub included, keep their retries', () => {
		const t = createRegistryThrottle();
		t.noteCheck('lscr.io/linuxserver/duckdns:latest', CHECK_429);
		expect(t.delays('ghcr.io/linuxserver/duckdns:latest')).toEqual(PULL_RETRY_DELAYS_MS);
		expect(t.delays('nginx:1.27')).toEqual(PULL_RETRY_DELAYS_MS);
		expect(t.delays('library/nginx:1.27')).toEqual(PULL_RETRY_DELAYS_MS);
	});

	test('Docker Hub images share one entry, with or without an org', () => {
		const t = createRegistryThrottle();
		t.notePull('nginx:1.27', new Error('Failed to pull image: toomanyrequests: You have reached your pull rate limit.'));
		expect(t.delays('linuxserver/duckdns:latest')).toEqual([]);
		expect(t.delays('lscr.io/linuxserver/duckdns:latest')).toEqual(PULL_RETRY_DELAYS_MS);
	});

	test('only a rate limit counts', () => {
		const t = createRegistryThrottle();
		t.noteCheck('lscr.io/a:1', 'Registry server error (503)');
		t.noteCheck('lscr.io/a:1', undefined);
		t.notePull('lscr.io/a:1', new Error('Failed to pull image: manifest unknown'));
		expect(t.delays('lscr.io/a:1')).toEqual(PULL_RETRY_DELAYS_MS);
	});

	test('a run of checks: the second image of a throttled registry is checked once', async () => {
		const t = createRegistryThrottle();
		let calls = 0;
		const check = async () => { calls++; return { error: CHECK_429 }; };
		const sleep = async () => {};
		await withCheckRetry(check, { sleep, delays: t.delays('lscr.io/linuxserver/duckdns:latest') });
		t.noteCheck('lscr.io/linuxserver/duckdns:latest', CHECK_429);
		expect(calls).toBe(4);
		await withCheckRetry(check, { sleep, delays: t.delays('lscr.io/linuxserver/wireguard:latest') });
		expect(calls).toBe(5);
	});
});

describe('the environment update check uses the throttle', () => {
	const { readFileSync } = require('node:fs') as typeof import('node:fs');
	const src = readFileSync(new URL('../src/lib/server/scheduler/tasks/env-update-check.ts', import.meta.url), 'utf8');

	test('checks take their waits from it and report back', () => {
		expect(src).toContain('delays: throttle.delays(imageName) });');
		expect(src).toContain('throttle.noteCheck(imageName, result.error);');
	});

	test('one throttle per run: made before the container loop, a check reports right after it', () => {
		const made = src.indexOf('const throttle = createRegistryThrottle();');
		expect(made).toBeGreaterThan(-1);
		expect(made).toBeLessThan(src.indexOf('for (const container of containers)'));
		expect(src.match(/createRegistryThrottle\(\)/g)?.length).toBe(1);
		expect(src).toMatch(/delays: throttle\.delays\(imageName\) \}\);\n\t+throttle\.noteCheck\(imageName, result\.error\);/);
	});

	test('a pull that worked clears its registry', () => {
		expect(src.match(/delays: throttle\.delays\(update\.imageName\) \}\);\n\t+throttle\.notePull\(update\.imageName, null\);/g)?.length).toBe(2);
	});

	test('pulls take their waits from it and a failed pull reports back', () => {
		expect(src.match(/delays: throttle\.delays\(update\.imageName\) \}\)/g)?.length).toBe(2);
		expect(src).toContain('throttle.notePull(update.imageName, err);');
	});
});

describe('the throttle clears once a registry answers', () => {
	test('a check that got an answer gives its registry its retries back', () => {
		const t = createRegistryThrottle();
		t.noteCheck('lscr.io/linuxserver/duckdns:latest', CHECK_429);
		t.noteCheck('lscr.io/linuxserver/wireguard:latest', undefined);
		expect(t.delays('lscr.io/linuxserver/syncthing:latest')).toEqual(PULL_RETRY_DELAYS_MS);
	});

	test('a check that failed for another reason also counts as an answer', () => {
		const t = createRegistryThrottle();
		t.noteCheck('lscr.io/a:1', CHECK_429);
		t.noteCheck('lscr.io/b:1', 'Registry returned 404 (image or tag not found - deleted upstream, private, or a locally built image)');
		expect(t.delays('lscr.io/c:1')).toEqual(PULL_RETRY_DELAYS_MS);
	});

	test('a pull that worked clears it; one that failed for another reason does not', () => {
		const t = createRegistryThrottle();
		t.noteCheck('lscr.io/a:1', CHECK_429);
		t.notePull('lscr.io/b:1', new Error('Failed to recreate container'));
		expect(t.delays('lscr.io/c:1')).toEqual([]);
		t.notePull('lscr.io/b:1', null);
		expect(t.delays('lscr.io/c:1')).toEqual(PULL_RETRY_DELAYS_MS);
	});
});

describe('checkRetryAfterMs', () => {
	const now = Date.parse('Tue, 27 Oct 2026 14:00:00 GMT');

	test('reads the seconds form', () => {
		expect(checkRetryAfterMs('Rate limited by registry (429, retry after 3600s)', now)).toBe(3_600_000);
	});

	test('reads an HTTP date as the time left until it', () => {
		expect(checkRetryAfterMs('Rate limited by registry (429, retry after Tue, 27 Oct 2026 15:00:00 GMT)', now)).toBe(3_600_000);
		expect(checkRetryAfterMs('Rate limited by registry (429, retry after Tue, 27 Oct 2026 13:00:00 GMT)', now)).toBe(0);
	});

	test('no retry-after, or one it cannot read, is null', () => {
		expect(checkRetryAfterMs(CHECK_429, now)).toBeNull();
		expect(checkRetryAfterMs('Rate limited by registry (429, retry after soon)', now)).toBeNull();
	});

	test('a registry giving a date an hour away is not retried', async () => {
		let calls = 0;
		const later = new Date(Date.now() + 3_600_000).toUTCString();
		await withCheckRetry(async () => { calls++; return { error: `Rate limited by registry (429, retry after ${later})` }; }, { sleep: async () => {} });
		expect(calls).toBe(1);
	});
});

describe('no retries left for a throttled registry', () => {
	test('the check says the registry kept refusing, not "after 1 attempts"', async () => {
		const lines: string[] = [];
		await withCheckRetry(async () => ({ error: CHECK_429 }), { delays: [], log: (m) => lines.push(m) });
		expect(lines).toEqual(['Registry rate limit: the registry kept refusing earlier in this run, not retrying the check']);
	});

	test('so does the pull', async () => {
		const lines: string[] = [];
		await expect(withPullRetry(async () => { throw new Error(STREAM); }, { delays: [], log: (m) => lines.push(m) })).rejects.toThrow('toomanyrequests');
		expect(lines).toEqual(['Registry rate limit: the registry kept refusing earlier in this run, not retrying the pull']);
	});
});
