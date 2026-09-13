/**
 * Pure tally + summary for the "Test all destinations" action. A destination test
 * has three outcomes, not two: a reachable-but-uninitialized repo is `needs_init`,
 * NOT a failure. Kept dependency-free so it's unit-testable without the DOM.
 */

export type TestOutcome = 'success' | 'needs_init' | 'failed';

export interface TestCounts {
	passed: number;
	failed: number;
	needsInit: number;
}

/** Count each three-way test outcome. Anything not 'success'/'needs_init' is a failure. */
export function summarizeTestResults(outcomes: TestOutcome[]): TestCounts {
	const counts: TestCounts = { passed: 0, failed: 0, needsInit: 0 };
	for (const o of outcomes) {
		if (o === 'success') counts.passed++;
		else if (o === 'needs_init') counts.needsInit++;
		else counts.failed++;
	}
	return counts;
}

/**
 * Toast text + severity for a tally. Real failures make it an error; needs-init
 * without failures is a warning (action needed, but nothing is broken); all-pass
 * is a success.
 */
export function formatTestSummary(counts: TestCounts): {
	text: string;
	severity: 'success' | 'warning' | 'error';
} {
	const { passed, failed, needsInit } = counts;
	const parts: string[] = [`${passed} passed`];
	if (failed > 0) parts.push(`${failed} failed`);
	if (needsInit > 0) parts.push(`${needsInit} need init`);

	if (failed > 0) return { text: parts.join(', '), severity: 'error' };
	if (needsInit > 0) return { text: parts.join(', '), severity: 'warning' };
	return { text: `All ${passed} destinations tested & stats collected`, severity: 'success' };
}
