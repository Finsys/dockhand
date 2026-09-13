import { describe, test, expect } from 'bun:test';
import {
	hexToRgba,
	getLabelColor,
	getLabelBgColor,
	getLabelColors,
	parseLabels,
	serializeLabels,
	MAX_LABELS
} from '../src/lib/utils/label-colors';

describe('hexToRgba', () => {
	test('converts hex to rgba with default alpha', () => {
		expect(hexToRgba('#ef4444')).toBe('rgba(239, 68, 68, 0.15)');
	});

	test('converts hex to rgba with custom alpha', () => {
		expect(hexToRgba('#3b82f6', 0.5)).toBe('rgba(59, 130, 246, 0.5)');
	});

	test('handles black', () => {
		expect(hexToRgba('#000000', 1)).toBe('rgba(0, 0, 0, 1)');
	});

	test('handles white', () => {
		expect(hexToRgba('#ffffff', 0.2)).toBe('rgba(255, 255, 255, 0.2)');
	});
});

describe('getLabelColor', () => {
	test('returns a hex color string', () => {
		const color = getLabelColor('production');
		expect(color).toMatch(/^#[0-9a-f]{6}$/);
	});

	test('is deterministic — same input gives same color', () => {
		expect(getLabelColor('staging')).toBe(getLabelColor('staging'));
	});

	test('different labels can produce different colors', () => {
		// Not guaranteed for any two labels, but "a" and "b" should differ
		const colors = new Set(['a', 'b', 'c', 'd', 'e', 'production', 'staging', 'dev'].map(getLabelColor));
		expect(colors.size).toBeGreaterThan(1);
	});

	test('uses custom color when provided', () => {
		const custom = { production: '#ff0000' };
		expect(getLabelColor('production', custom)).toBe('#ff0000');
	});

	test('falls back to hash when label not in custom colors', () => {
		const custom = { production: '#ff0000' };
		const color = getLabelColor('staging', custom);
		expect(color).not.toBe('#ff0000');
		expect(color).toMatch(/^#[0-9a-f]{6}$/);
	});
});

describe('getLabelBgColor', () => {
	test('returns an rgba string', () => {
		const bg = getLabelBgColor('production');
		expect(bg).toMatch(/^rgba\(\d+, \d+, \d+, [\d.]+\)$/);
	});

	test('uses custom color with alpha when provided', () => {
		const custom = { test: '#3b82f6' };
		expect(getLabelBgColor('test', custom)).toBe('rgba(59, 130, 246, 0.15)');
	});
});

describe('getLabelColors', () => {
	test('returns both color and bgColor', () => {
		const { color, bgColor } = getLabelColors('production');
		expect(color).toMatch(/^#[0-9a-f]{6}$/);
		expect(bgColor).toMatch(/^rgba\(/);
	});

	test('custom colors return matching pair', () => {
		const custom = { myLabel: '#ef4444' };
		const { color, bgColor } = getLabelColors('myLabel', custom);
		expect(color).toBe('#ef4444');
		expect(bgColor).toBe('rgba(239, 68, 68, 0.15)');
	});
});

describe('parseLabels', () => {
	test('returns empty array for null', () => {
		expect(parseLabels(null)).toEqual([]);
	});

	test('returns empty array for undefined', () => {
		expect(parseLabels(undefined)).toEqual([]);
	});

	test('returns empty array for empty string', () => {
		expect(parseLabels('')).toEqual([]);
	});

	test('passes through arrays as-is', () => {
		expect(parseLabels(['a', 'b'])).toEqual(['a', 'b']);
	});

	test('parses JSON string', () => {
		expect(parseLabels('["prod","staging"]')).toEqual(['prod', 'staging']);
	});

	test('returns empty array for invalid JSON', () => {
		expect(parseLabels('not json')).toEqual([]);
	});

	test('returns empty array for non-array JSON', () => {
		expect(parseLabels('{"key":"value"}')).toEqual([]);
	});
});

describe('serializeLabels', () => {
	test('returns JSON string for labels', () => {
		expect(serializeLabels(['a', 'b'])).toBe('["a","b"]');
	});

	test('returns null for empty array', () => {
		expect(serializeLabels([])).toBeNull();
	});
});

describe('MAX_LABELS', () => {
	test('is 10', () => {
		expect(MAX_LABELS).toBe(10);
	});
});
