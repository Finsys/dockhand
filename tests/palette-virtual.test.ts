import { describe, test, expect } from 'bun:test';
import { buildOffsets, rowAtOffset, visibleRange } from '../src/lib/utils/palette-virtual';

describe('buildOffsets', () => {
	test('prefix-sum with a final total', () => {
		expect(buildOffsets([28, 44, 44, 28, 44])).toEqual([0, 28, 72, 116, 144, 188]);
	});
	test('empty -> [0]', () => {
		expect(buildOffsets([])).toEqual([0]);
	});
});

describe('rowAtOffset', () => {
	const offsets = buildOffsets([28, 44, 44, 28, 44]); // 5 rows -> [0,28,72,116,144,188]

	test('exact row tops map to that row', () => {
		expect(rowAtOffset(offsets, 0)).toBe(0);
		expect(rowAtOffset(offsets, 28)).toBe(1);
		expect(rowAtOffset(offsets, 72)).toBe(2);
		expect(rowAtOffset(offsets, 144)).toBe(4);
	});
	test('a y inside a row maps to that row', () => {
		expect(rowAtOffset(offsets, 50)).toBe(1); // within row 1 [28,72)
		expect(rowAtOffset(offsets, 143)).toBe(3); // within row 3 [116,144)
	});
	test('y below 0 clamps to first row', () => {
		expect(rowAtOffset(offsets, -100)).toBe(0);
	});
	test('y past the end clamps to the last row', () => {
		expect(rowAtOffset(offsets, 9999)).toBe(4);
	});
	test('empty list -> 0', () => {
		expect(rowAtOffset([0], 42)).toBe(0);
	});
});

describe('visibleRange', () => {
	const offsets = buildOffsets(new Array(100).fill(44)); // 100 uniform rows

	test('window covers the viewport plus buffer on both sides', () => {
		// scrollTop 440 (row 10), viewport 220 (5 rows), buffer 2
		const { start, end } = visibleRange(offsets, 440, 220, 2);
		expect(start).toBe(8); // row 10 - 2
		// bottom offset 660 -> row 15; +2 buffer +1 exclusive end
		expect(end).toBe(18);
		expect(end - start).toBeLessThanOrEqual(220 / 44 + 2 * 2 + 2); // bounded, not O(total)
	});
	test('at the top, start clamps to 0', () => {
		expect(visibleRange(offsets, 0, 220, 6).start).toBe(0);
	});
	test('at the bottom, end clamps to row count', () => {
		expect(visibleRange(offsets, 4400, 220, 6).end).toBe(100);
	});
	test('empty list -> {0,0}', () => {
		expect(visibleRange([0], 0, 220, 6)).toEqual({ start: 0, end: 0 });
	});
});
