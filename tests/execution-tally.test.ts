/**
 * Unit tests for computeExecutionTally (src/lib/utils/execution-tally.ts) — the
 * pure ok/fail tally + newest-first sort behind the backup History tab and the
 * modal tab counters. UI-free so it runs under bun test.
 */
import { describe, test, expect } from 'bun:test';
import { computeExecutionTally, resolveRunRepo, type RunRepo, type Execution } from '../src/lib/utils/execution-tally';

const ex = (over: Partial<Execution>): Execution => ({
	id: 1, triggeredAt: '2026-07-22T03:00:00Z', triggeredBy: 'cron',
	status: 'success', duration: 4000, errorMessage: null, details: null, ...over,
});

describe('computeExecutionTally — the red ✕N / green ✓N counters', () => {
	test('empty input → zero tally, empty list', () => {
		expect(computeExecutionTally([])).toEqual({ executions: [], ok: 0, failed: 0 });
	});

	test('success / warning / skipped all count as OK; only failed is red', () => {
		const t = computeExecutionTally([
			ex({ id: 1, status: 'success' }),
			ex({ id: 2, status: 'warning' }),
			ex({ id: 3, status: 'skipped' }),
			ex({ id: 4, status: 'failed' }),
		]);
		expect(t.ok).toBe(3);
		expect(t.failed).toBe(1);
	});

	test('running / queued count as NEITHER (in-flight, no outcome yet)', () => {
		const t = computeExecutionTally([
			ex({ id: 1, status: 'running' }),
			ex({ id: 2, status: 'queued' }),
			ex({ id: 3, status: 'success' }),
		]);
		expect(t.ok).toBe(1);
		expect(t.failed).toBe(0);
	});

	test('an unknown status counts as neither ok nor failed', () => {
		const t = computeExecutionTally([ex({ status: 'bananas' as any })]);
		expect(t).toMatchObject({ ok: 0, failed: 0 });
	});
});

describe('computeExecutionTally — newest-first sort (merged across configs)', () => {
	test('sorts by triggeredAt descending regardless of input order', () => {
		const t = computeExecutionTally([
			ex({ id: 1, triggeredAt: '2026-07-20T03:00:00Z' }),
			ex({ id: 2, triggeredAt: '2026-07-22T03:00:00Z' }),
			ex({ id: 3, triggeredAt: '2026-07-21T03:00:00Z' }),
		]);
		expect(t.executions.map((e) => e.id)).toEqual([2, 3, 1]);
	});

	test('null triggeredAt sorts to the end (oldest)', () => {
		const t = computeExecutionTally([
			ex({ id: 1, triggeredAt: null }),
			ex({ id: 2, triggeredAt: '2026-07-22T03:00:00Z' }),
		]);
		expect(t.executions.map((e) => e.id)).toEqual([2, 1]);
	});

	test('does not mutate the input array', () => {
		const input = [
			ex({ id: 1, triggeredAt: '2026-07-20T03:00:00Z' }),
			ex({ id: 2, triggeredAt: '2026-07-22T03:00:00Z' }),
		];
		const before = input.map((e) => e.id);
		computeExecutionTally(input);
		expect(input.map((e) => e.id)).toEqual(before);
	});
});

describe('resolveRunRepo (#1783 - a run reports the repo it used, not the config current one)', () => {
	const A: RunRepo = { repository: '/mnt/tempA', name: 'Temp A' };
	const B: RunRepo = { repository: 'rest:backup-server', name: 'Backup-Server' };
	const destById = new Map<number, RunRepo>([[1, A], [2, B]]);
	const configDest = B; // the schedule's CURRENT destination (was re-pointed from A to B)

	test('a run stamped with its own destination reports THAT, not the config current', () => {
		// The bug: both runs showed B (current). A run that wrote to dest 1 must show A.
		expect(resolveRunRepo(1, destById, configDest)).toEqual(A);
		expect(resolveRunRepo(2, destById, configDest)).toEqual(B);
	});

	test('an unstamped (older) run falls back to the config destination', () => {
		expect(resolveRunRepo(undefined, destById, configDest)).toEqual(configDest);
	});

	test('a stamped id with no matching destination falls back to the config', () => {
		// Destination deleted since the run: better to show the config than nothing.
		expect(resolveRunRepo(999, destById, configDest)).toEqual(configDest);
	});

	test('no destById map at all falls back to the config (surfaces that omit the Repo column)', () => {
		expect(resolveRunRepo(1, undefined, configDest)).toEqual(configDest);
		expect(resolveRunRepo(undefined, undefined, undefined)).toBeUndefined();
	});
});
