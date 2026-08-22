import { describe, test, expect } from 'bun:test';
import { shouldBlockUpdate, combineScanSummaries } from '../src/lib/server/scheduler/tasks/update-utils';

const clean = { critical: 0, high: 0, medium: 0, low: 0, negligible: 0, unknown: 0 };

describe('shouldBlockUpdate', () => {
	test('never blocks with "never" criteria', () => {
		const vulny = { ...clean, critical: 5, high: 10 };
		expect(shouldBlockUpdate('never', vulny).blocked).toBe(false);
	});

	test('"any" blocks when any vulnerabilities exist', () => {
		expect(shouldBlockUpdate('any', { ...clean, low: 1 }).blocked).toBe(true);
		expect(shouldBlockUpdate('any', clean).blocked).toBe(false);
	});

	test('"critical_high" blocks on critical or high only', () => {
		expect(shouldBlockUpdate('critical_high', { ...clean, critical: 1 }).blocked).toBe(true);
		expect(shouldBlockUpdate('critical_high', { ...clean, high: 1 }).blocked).toBe(true);
		expect(shouldBlockUpdate('critical_high', { ...clean, medium: 5 }).blocked).toBe(false);
		expect(shouldBlockUpdate('critical_high', { ...clean, low: 10 }).blocked).toBe(false);
	});

	test('"critical" blocks on critical only', () => {
		expect(shouldBlockUpdate('critical', { ...clean, critical: 1 }).blocked).toBe(true);
		expect(shouldBlockUpdate('critical', { ...clean, high: 10 }).blocked).toBe(false);
	});

	test('"more_than_current" blocks when new > current', () => {
		const current = { ...clean, low: 5 };
		const newMore = { ...clean, low: 6 };
		const newLess = { ...clean, low: 4 };
		const newEqual = { ...clean, low: 5 };

		expect(shouldBlockUpdate('more_than_current', newMore, current).blocked).toBe(true);
		expect(shouldBlockUpdate('more_than_current', newLess, current).blocked).toBe(false);
		expect(shouldBlockUpdate('more_than_current', newEqual, current).blocked).toBe(false);
	});

	test('"more_than_current" does not block without current scan', () => {
		expect(shouldBlockUpdate('more_than_current', { ...clean, critical: 100 }).blocked).toBe(false);
	});

	test('returns reason string when blocked', () => {
		const result = shouldBlockUpdate('critical', { ...clean, critical: 3 });
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain('3 critical');
	});

	// --- M7 regression ---
	// The 'more_than_current' comparison is gated on a current scan summary; the
	// env-wide update path used to pass undefined, so it silently never blocked.
	// These pin the contract that env-update-check.ts now relies on.
	test('M7: passing undefined current scan never blocks, even for a very vulnerable image', () => {
		const veryVulnerable = { ...clean, critical: 50, high: 50, medium: 50, low: 50 };
		expect(shouldBlockUpdate('more_than_current', veryVulnerable, undefined).blocked).toBe(false);
	});

	test('M7: blocks when current scan is supplied and new has more vulns', () => {
		const current = { ...clean, critical: 1, high: 1 }; // 2 total
		const newMore = { ...clean, critical: 2, high: 1 }; // 3 total
		const { blocked, reason } = shouldBlockUpdate('more_than_current', newMore, current);
		expect(blocked).toBe(true);
		expect(reason).toContain('3');
		expect(reason).toContain('2');
	});

	test('returns empty reason when not blocked', () => {
		expect(shouldBlockUpdate('never', { ...clean, critical: 5 }).reason).toBe('');
	});

	test('"any" reason includes all severity counts', () => {
		const scan = { ...clean, critical: 1, high: 2, medium: 3, low: 4 };
		const result = shouldBlockUpdate('any', scan);
		expect(result.reason).toContain('1 critical');
		expect(result.reason).toContain('2 high');
		expect(result.reason).toContain('3 medium');
		expect(result.reason).toContain('4 low');
	});
});

describe('combineScanSummaries', () => {
	test('returns zeros for empty input', () => {
		expect(combineScanSummaries([])).toEqual(clean);
	});

	test('returns single result as-is', () => {
		const summary = { ...clean, critical: 3, high: 5 };
		expect(combineScanSummaries([{ summary }])).toEqual(summary);
	});

	test('takes maximum of each severity across scanners', () => {
		const grype = { summary: { critical: 2, high: 5, medium: 0, low: 1, negligible: 0, unknown: 0 } };
		const trivy = { summary: { critical: 3, high: 1, medium: 4, low: 0, negligible: 2, unknown: 1 } };

		expect(combineScanSummaries([grype, trivy])).toEqual({
			critical: 3,
			high: 5,
			medium: 4,
			low: 1,
			negligible: 2,
			unknown: 1
		});
	});

	test('handles three scanners', () => {
		const a = { summary: { ...clean, critical: 1 } };
		const b = { summary: { ...clean, critical: 5 } };
		const c = { summary: { ...clean, critical: 3 } };

		expect(combineScanSummaries([a, b, c]).critical).toBe(5);
	});
});
