/**
 * Unit tests for the "Test all destinations" tally. Regression guard: the toast used
 * to report needs-init repos as "failed" (a reachable-but-uninitialized repo counted
 * as a failure), producing "6 failed, 4 passed" when 5 of the 6 only needed init.
 */
import { describe, test, expect } from 'bun:test';
import { summarizeTestResults, formatTestSummary } from '../src/lib/utils/backup-test-summary';

describe('summarizeTestResults', () => {
	test('counts the three outcomes separately', () => {
		expect(summarizeTestResults(['success', 'success', 'needs_init', 'failed', 'needs_init']))
			.toEqual({ passed: 2, failed: 1, needsInit: 2 });
	});

	test('needs_init is never counted as failed (the bug)', () => {
		const c = summarizeTestResults(['needs_init', 'needs_init', 'needs_init', 'needs_init', 'needs_init', 'failed', 'success', 'success', 'success', 'success']);
		expect(c).toEqual({ passed: 4, failed: 1, needsInit: 5 });
	});

	test('empty input yields all zeroes', () => {
		expect(summarizeTestResults([])).toEqual({ passed: 0, failed: 0, needsInit: 0 });
	});
});

describe('formatTestSummary', () => {
	test('all passed -> success', () => {
		const r = formatTestSummary({ passed: 3, failed: 0, needsInit: 0 });
		expect(r.severity).toBe('success');
		expect(r.text).toContain('3');
	});

	test('only needs-init (no real failures) -> warning', () => {
		const r = formatTestSummary({ passed: 4, failed: 0, needsInit: 5 });
		expect(r.severity).toBe('warning');
		expect(r.text).toBe('4 passed, 5 need init');
	});

	test('any real failure -> error, includes all buckets present', () => {
		const r = formatTestSummary({ passed: 4, failed: 1, needsInit: 5 });
		expect(r.severity).toBe('error');
		expect(r.text).toBe('4 passed, 1 failed, 5 need init');
	});

	test('failures without needs-init -> error, no "need init" clause', () => {
		const r = formatTestSummary({ passed: 2, failed: 3, needsInit: 0 });
		expect(r.severity).toBe('error');
		expect(r.text).toBe('2 passed, 3 failed');
	});
});
