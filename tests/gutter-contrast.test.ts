import { describe, test, expect } from 'bun:test';
import { parseRgb, luminance, gutterBackgroundFor } from '../src/lib/utils/gutter-contrast';

describe('gutter-contrast', () => {
	test('parseRgb reads rgb() and rgba()', () => {
		expect(parseRgb('rgb(46, 52, 64)')).toEqual({ r: 46, g: 52, b: 64 });
		expect(parseRgb('rgba(255, 255, 255, 0.5)')).toEqual({ r: 255, g: 255, b: 255 });
		expect(parseRgb('RGB( 1 , 2 , 3 )')).toEqual({ r: 1, g: 2, b: 3 });
	});

	test('parseRgb returns null for non-rgb inputs', () => {
		expect(parseRgb('transparent')).toBeNull();
		expect(parseRgb('#2e3440')).toBeNull();
		expect(parseRgb('')).toBeNull();
		expect(parseRgb(null)).toBeNull();
		expect(parseRgb(undefined)).toBeNull();
	});

	test('luminance orders dark below light', () => {
		expect(luminance({ r: 0, g: 0, b: 0 })).toBe(0);
		expect(luminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(255, 0);
		expect(luminance({ r: 46, g: 52, b: 64 })).toBeLessThan(128); // Nord bg is dark
	});

	test('a dark background yields a LIGHTER gutter', () => {
		// Nord background rgb(46,52,64) -> each channel +24
		expect(gutterBackgroundFor('rgb(46, 52, 64)')).toBe('rgb(70, 76, 88)');
	});

	test('a light background yields a DARKER gutter', () => {
		// GitHub Light background rgb(255,255,255) -> each channel -24
		expect(gutterBackgroundFor('rgb(255, 255, 255)')).toBe('rgb(231, 231, 231)');
	});

	test('channels clamp at 0 and 255', () => {
		expect(gutterBackgroundFor('rgb(0, 0, 0)')).toBe('rgb(24, 24, 24)'); // black lightens
		expect(gutterBackgroundFor('rgb(250, 250, 250)', 24)).toBe('rgb(226, 226, 226)');
		// near-black with a big step never goes negative
		expect(gutterBackgroundFor('rgb(5, 5, 5)', 100)).toBe('rgb(105, 105, 105)');
	});

	test('unparseable background returns null so the caller keeps its fallback', () => {
		expect(gutterBackgroundFor('transparent')).toBeNull();
		expect(gutterBackgroundFor(null)).toBeNull();
	});

	test('the shift is always visible (>= 24 per channel by default)', () => {
		for (const bg of ['rgb(40, 42, 54)', 'rgb(30, 30, 30)', 'rgb(253, 246, 227)']) {
			const out = gutterBackgroundFor(bg)!;
			const before = parseRgb(bg)!;
			const after = parseRgb(out)!;
			expect(Math.abs(after.r - before.r)).toBeGreaterThanOrEqual(24);
		}
	});
});
