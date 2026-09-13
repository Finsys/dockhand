import { describe, expect, test } from 'bun:test';
import { planReconcile, isEligibleForMissingMark } from '../src/lib/server/deploy-log-reconcile-core';

describe('planReconcile', () => {
	test('deletes a file whose run record is gone', () => {
		const plan = planReconcile({ fileIds: ['a', 'b'], recordIds: ['a'] });
		expect(plan.deleteFiles).toEqual(['b']);
		expect(plan.markMissing).toEqual([]);
	});

	test('marks a record whose file is gone but never deletes the record', () => {
		// The metadata -- when, who, what was built, which digest -- stays valuable
		// even when the log itself is gone.
		const plan = planReconcile({ fileIds: [], recordIds: ['a'] });
		expect(plan.markMissing).toEqual(['a']);
		expect(plan.deleteFiles).toEqual([]);
	});

	test('leaves matching pairs alone', () => {
		const plan = planReconcile({ fileIds: ['a'], recordIds: ['a'] });
		expect(plan.deleteFiles).toEqual([]);
		expect(plan.markMissing).toEqual([]);
	});
});

describe('isEligibleForMissingMark', () => {
	// A still-running deploy may simply not have written its first log line yet --
	// marking it here would produce a false "log missing" that nothing later clears.
	test('excludes still in-progress runs', () => {
		expect(isEligibleForMissingMark('queued')).toBe(false);
		expect(isEligibleForMissingMark('running')).toBe(false);
	});

	test('includes every terminal state', () => {
		for (const status of ['success', 'failed', 'skipped', 'warning', 'error', 'cancelled', 'stale']) {
			expect(isEligibleForMissingMark(status)).toBe(true);
		}
	});
});
