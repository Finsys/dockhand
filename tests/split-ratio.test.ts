import { describe, expect, test } from 'bun:test';
import { clampSplitRatio } from '../src/lib/utils/split-ratio';

// One test per case (not one test with several assertions) -- same reasoning as
// save-close-policy.test.ts: a failure in one case must not hide the others behind a
// single aborted test run.
describe('clampSplitRatio', () => {
	test('a value below the minimum is pulled up to the minimum', () => {
		expect(clampSplitRatio(5, 15, 70)).toBe(15);
	});

	test('a value above the maximum is pulled down to the maximum', () => {
		expect(clampSplitRatio(90, 15, 70)).toBe(70);
	});

	test('a value already inside the bounds is left unchanged', () => {
		expect(clampSplitRatio(42, 15, 70)).toBe(42);
	});

	test('NaN is not passed through -- it falls back to the minimum', () => {
		// This is the real-world trigger: the dragged container's height is briefly 0
		// (e.g. mid-drag while the panel is transitioning), so the ratio computation
		// divides by zero and produces NaN. Math.max(30, Math.min(80, NaN)) itself
		// evaluates to NaN -- any NaN operand makes both Math.min and Math.max return
		// NaN, so the naive clamp does not clamp at all.
		expect(clampSplitRatio(NaN, 15, 70)).toBe(15);
	});

	test('a negative proposal is clamped to the minimum, not left negative', () => {
		expect(clampSplitRatio(-20, 15, 70)).toBe(15);
	});

	test('positive Infinity clamps to the maximum via the ordinary Math.min/max path', () => {
		// Unlike NaN, Infinity is a well-ordered number -- Math.min(max, Infinity) is
		// max, so no special-casing is needed for it to land on the maximum.
		expect(clampSplitRatio(Infinity, 15, 70)).toBe(70);
	});
});
