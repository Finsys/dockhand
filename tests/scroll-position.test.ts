import { describe, expect, test } from 'bun:test';
import { isScrolledToBottom } from '../src/lib/utils/scroll-position';

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
