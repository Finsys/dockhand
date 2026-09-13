import { describe, test, expect } from 'bun:test';
import { parseTimeStringToSeconds } from '../src/lib/utils/parse-uptime';

describe('parseTimeStringToSeconds (#1395 uptime sorting)', () => {
	test('sub-minute values keep their real magnitude (the bug: they all collapsed to 1)', () => {
		expect(parseTimeStringToSeconds('5 seconds')).toBe(5);
		expect(parseTimeStringToSeconds('45 seconds')).toBe(45);
		expect(parseTimeStringToSeconds('1 second')).toBe(1);
		// distinct sub-minute values must sort against each other, not tie at 1
		expect(parseTimeStringToSeconds('5 seconds')).not.toBe(parseTimeStringToSeconds('45 seconds'));
	});

	test('only the literal "less than a second" collapses to 1', () => {
		expect(parseTimeStringToSeconds('Less than a second')).toBe(1);
	});

	test('minute phrasings', () => {
		expect(parseTimeStringToSeconds('Less than a minute')).toBe(60);
		expect(parseTimeStringToSeconds('About a minute')).toBe(60);
		expect(parseTimeStringToSeconds('2 minutes')).toBe(120);
	});

	test('larger units', () => {
		expect(parseTimeStringToSeconds('3 hours')).toBe(10800);
		expect(parseTimeStringToSeconds('5 days')).toBe(432000);
		expect(parseTimeStringToSeconds('2 weeks')).toBe(1209600);
		expect(parseTimeStringToSeconds('1 month')).toBe(2592000);
		expect(parseTimeStringToSeconds('1 year')).toBe(31536000);
	});

	test('unparseable strings return 0', () => {
		expect(parseTimeStringToSeconds('')).toBe(0);
		expect(parseTimeStringToSeconds('just now')).toBe(0);
	});

	test('case-insensitive', () => {
		expect(parseTimeStringToSeconds('45 SECONDS')).toBe(45);
		expect(parseTimeStringToSeconds('3 Hours')).toBe(10800);
	});
});
