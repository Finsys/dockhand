import { describe, expect, test } from 'bun:test';
import { isScrolledToBottom, shouldResetScrollPause } from '../src/lib/utils/scroll-position';

describe('isScrolledToBottom', () => {
	test('is true when the element is exactly at the end', () => {
		expect(isScrolledToBottom(400, 500, 100)).toBe(true);
	});

	test('is true within the default 50px threshold', () => {
		expect(isScrolledToBottom(370, 500, 100)).toBe(true);
	});

	// One case at the boundary and one just past it -- otherwise an off-by-one in the
	// comparison (< vs <=) leaves every other test green.
	test('is true exactly at the threshold and false one pixel past it', () => {
		expect(isScrolledToBottom(350, 500, 100)).toBe(true);
		expect(isScrolledToBottom(349, 500, 100)).toBe(false);
	});

	test('is false once the user has scrolled well up from the end', () => {
		expect(isScrolledToBottom(100, 500, 100)).toBe(false);
	});

	test('accepts a custom threshold', () => {
		expect(isScrolledToBottom(390, 500, 100, 5)).toBe(false);
		expect(isScrolledToBottom(395, 500, 100, 5)).toBe(true);
	});
});

describe('shouldResetScrollPause', () => {
	test('lifts the pause when a fresh run starts (false -> true)', () => {
		expect(shouldResetScrollPause(false, true)).toBe(true);
	});

	// This is the case that catches the bug reported live: a viewer scrolls up during one
	// run, and every later run of the same page session stays paused because nothing ever
	// clears it. A naive "reset whenever autoScroll is true" implementation returns true
	// here too -- which reads as similar but re-lifts the pause on every update while a run
	// is already in progress, defeating the pause entirely. Only the false -> true edge
	// (a *new* run starting) may lift it.
	test('does not re-lift the pause on every update while a run is already in progress', () => {
		expect(shouldResetScrollPause(true, true)).toBe(false);
	});

	test('does nothing when a run ends (true -> false)', () => {
		expect(shouldResetScrollPause(true, false)).toBe(false);
	});

	test('does nothing while idle (false -> false)', () => {
		expect(shouldResetScrollPause(false, false)).toBe(false);
	});
});
