/**
 * Unit tests for computeExecutionTally (src/lib/utils/execution-tally.ts) — the
 * pure ok/fail tally + newest-first sort behind the backup History tab and the
 * modal tab counters. UI-free so it runs under bun test.
 */
import { describe, test, expect } from 'bun:test';
import { computeExecutionTally, type Execution } from '../src/lib/utils/execution-tally';

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
