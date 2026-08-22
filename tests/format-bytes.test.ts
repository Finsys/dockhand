import { describe, expect, test } from 'bun:test';
import { formatBytes, formatBytesCompact } from '../src/lib/utils/format';

describe('formatBytes', () => {
	test('returns 0 B for zero', () => {
		expect(formatBytes(0)).toBe('0 B');
	});

	test('formats bytes', () => {
		expect(formatBytes(500)).toBe('500 B');
		expect(formatBytes(1)).toBe('1 B');
	});

	test('formats kilobytes', () => {
		expect(formatBytes(1024)).toBe('1.0 KB');
		expect(formatBytes(1536)).toBe('1.5 KB');
	});

	test('formats megabytes', () => {
		expect(formatBytes(1048576)).toBe('1.0 MB');
		expect(formatBytes(5242880)).toBe('5.0 MB');
	});

	test('formats gigabytes', () => {
		expect(formatBytes(1073741824)).toBe('1.0 GB');
	});

	test('formats terabytes', () => {
		expect(formatBytes(1099511627776)).toBe('1.0 TB');
	});

	test('respects decimals parameter', () => {
		expect(formatBytes(1536, 2)).toBe('1.50 KB');
		expect(formatBytes(1536, 0)).toBe('2 KB');
	});
});

describe('formatBytesCompact', () => {
	test('returns 0B for zero', () => {
		expect(formatBytesCompact(0)).toBe('0B');
	});

	test('uses compact units without space', () => {
		expect(formatBytesCompact(1024)).toBe('1.0K');
		expect(formatBytesCompact(1048576)).toBe('1.0M');
		expect(formatBytesCompact(1073741824)).toBe('1.0G');
		expect(formatBytesCompact(1099511627776)).toBe('1.0T');
	});

	test('respects decimals parameter', () => {
		expect(formatBytesCompact(1536, 0)).toBe('2K');
		expect(formatBytesCompact(1536, 2)).toBe('1.50K');
	});
});
