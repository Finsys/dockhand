/**
 * Unit tests for the internal-state getters the /metrics endpoint reads.
 * These modules are db-free, so they run under `bun test` (metrics.ts itself
 * transitively imports db.ts / better-sqlite3 and can't be unit-tested here).
 */
import { test, expect, describe, beforeEach } from 'bun:test';
import { getJobStats, createJob, completeJob, failJob, getJob, appendLine, cancelJob } from '../src/lib/server/jobs';
import { getVulnerabilitiesCacheStats, aggregateCache, inflight } from '../src/lib/server/vulnerabilities-cache';

describe('getJobStats', () => {
	test('counts jobs by status', () => {
		const before = getJobStats();
		const a = createJob(); // running
		const b = createJob(); completeJob(b, {}); // done
		const c = createJob(); failJob(c, 'boom'); // error
		const after = getJobStats();
		expect(after.running).toBe(before.running + 1);
		expect(after.done).toBe(before.done + 1);
		expect(after.error).toBe(before.error + 1);
		expect(after.total).toBe(after.running + after.done + after.error);
		void a;
	});
});

describe('job store lifecycle', () => {
	test('createJob starts a running job with an id, empty lines, and timestamps', () => {
		const j = createJob();
		expect(j.id).toBeTruthy();
		expect(j.status).toBe('running');
		expect(j.lines).toEqual([]);
		expect(j.createdAt).toBeGreaterThan(0);
		expect(getJob(j.id)).toBe(j);
	});
	test('getJob returns undefined for an unknown id', () => {
		expect(getJob('does-not-exist')).toBeUndefined();
	});
	test('appendLine pushes progress lines onto the job', () => {
		const j = createJob();
		appendLine(j, { event: 'progress', data: { pct: 10 } });
		appendLine(j, { event: 'progress', data: { pct: 20 } });
		expect(j.lines.length).toBe(2);
		expect(j.lines[1].data).toEqual({ pct: 20 });
	});
	test('completeJob marks done and stores the result', () => {
		const j = createJob();
		completeJob(j, { ok: true });
		expect(j.status).toBe('done');
		expect(j.result).toEqual({ ok: true });
	});
	test('failJob marks error and stores a {success:false,error} result', () => {
		const j = createJob();
		failJob(j, 'boom');
		expect(j.status).toBe('error');
		expect(j.result).toEqual({ success: false, error: 'boom' });
	});
	test('cancelJob cancels a running job (true) but not a terminal or unknown one (false)', () => {
		const running = createJob();
		expect(cancelJob(running.id)).toBe(true);

		const done = createJob();
		completeJob(done, {});
		expect(cancelJob(done.id)).toBe(false); // already terminal

		expect(cancelJob('nope')).toBe(false); // unknown id
	});
});

describe('getVulnerabilitiesCacheStats', () => {
	beforeEach(() => { aggregateCache.clear(); inflight.clear(); });

	test('reports zero for an empty cache', () => {
		expect(getVulnerabilitiesCacheStats()).toEqual({ envs: 0, views: 0, inflight: 0 });
	});

	test('counts environments, memoized views, and in-flight aggregations', () => {
		const emptySummary = { total: 0, critical: 0, high: 0, medium: 0, low: 0, imagesScanned: 0, totalImages: 0 };
		aggregateCache.set(1, { at: 0, data: { findings: [], summary: emptySummary }, views: new Map([['a', []], ['b', []]]) });
		aggregateCache.set(2, { at: 0, data: { findings: [], summary: emptySummary }, views: new Map([['c', []]]) });
		inflight.set(3, Promise.resolve({ findings: [], summary: emptySummary }));

		expect(getVulnerabilitiesCacheStats()).toEqual({ envs: 2, views: 3, inflight: 1 });
	});
});
