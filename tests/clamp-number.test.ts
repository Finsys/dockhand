import { describe, expect, test } from 'bun:test';
import { clampNumber } from '../src/lib/utils/clamp-number';

// One test per case (not one test with several assertions) -- same reasoning as
// save-close-policy.test.ts: a failure in one case must not hide the others behind a
// single aborted test run.
describe('clampNumber', () => {
	test('a value below the minimum is pulled up to the minimum', () => {
		expect(clampNumber(5, 15, 70)).toBe(15);
	});

	test('a value above the maximum is pulled down to the maximum', () => {
		expect(clampNumber(90, 15, 70)).toBe(70);
	});

	test('a value already inside the bounds is left unchanged', () => {
		expect(clampNumber(42, 15, 70)).toBe(42);
	});

	test('NaN is not passed through -- it falls back to the minimum', () => {
		// This is the real-world trigger: the dragged container's height (or width) is
		// briefly 0 (e.g. mid-drag while a panel is transitioning), so the ratio/distance
		// computation divides by zero and produces NaN. Math.max(30, Math.min(80, NaN))
		// itself evaluates to NaN -- any NaN operand makes both Math.min and Math.max
		// return NaN, so the naive clamp does not clamp at all.
		expect(clampNumber(NaN, 15, 70)).toBe(15);
	});

	test('a negative proposal is clamped to the minimum, not left negative', () => {
		expect(clampNumber(-20, 15, 70)).toBe(15);
	});

	test('positive Infinity clamps to the maximum via the ordinary Math.min/max path', () => {
		// Unlike NaN, Infinity is a well-ordered number -- Math.min(max, Infinity) is
		// max, so no special-casing is needed for it to land on the maximum.
		expect(clampNumber(Infinity, 15, 70)).toBe(70);
	});

	// The bounds above (15-70) are a percentage split ratio. This repo has a second,
	// independent caller with pixel bounds (the validate-panel width resizer,
	// 320-560px) -- proving the same function clamps correctly regardless of unit,
	// since it only compares `value` against `min`/`max` and never assumes a unit.
	test('pixel-range bounds (not a percentage) clamp the same way', () => {
		expect(clampNumber(200, 320, 560)).toBe(320);
		expect(clampNumber(9999, 320, 560)).toBe(560);
		expect(clampNumber(NaN, 320, 560)).toBe(320);
	});
});
