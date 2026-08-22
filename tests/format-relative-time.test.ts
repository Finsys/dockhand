/**
 * formatRelativeTime — compact "N ago" formatting with null/NaN/future safety.
 * Pure function in the import-light utils/format module (stores/settings re-exports it).
 *
 * Run with: bun test tests/unit/format-relative-time.test.ts
 */
import { describe, test, expect } from 'bun:test';
import { formatRelativeTime } from '../src/lib/utils/format';

// Build a timestamp `n` seconds in the past relative to now, so the tests are
// independent of the wall clock (no fixed dates that drift into other buckets).
const agoSec = (s: number) => new Date(Date.now() - s * 1000);
const MIN = 60, HR = 3600, DAY = 86400;

describe('formatRelativeTime — buckets', () => {
	test('under 45s reads "just now"', () => {
		expect(formatRelativeTime(agoSec(0))).toBe('just now');
		expect(formatRelativeTime(agoSec(44))).toBe('just now');
	});

	test('45s..59s rounds into minutes ("1m ago")', () => {
		// 45s -> round(45/60)=1 min
		expect(formatRelativeTime(agoSec(45))).toBe('1m ago');
	});

	test('minutes bucket (< 60m)', () => {
		expect(formatRelativeTime(agoSec(5 * MIN))).toBe('5m ago');
		expect(formatRelativeTime(agoSec(59 * MIN))).toBe('59m ago');
	});

	test('hours bucket (< 24h)', () => {
		expect(formatRelativeTime(agoSec(2 * HR))).toBe('2h ago');
		expect(formatRelativeTime(agoSec(23 * HR))).toBe('23h ago');
	});

	test('days bucket (< 30d)', () => {
		expect(formatRelativeTime(agoSec(3 * DAY))).toBe('3d ago');
		expect(formatRelativeTime(agoSec(29 * DAY))).toBe('29d ago');
	});

	test('months bucket (< 12mo)', () => {
		expect(formatRelativeTime(agoSec(60 * DAY))).toBe('2mo ago');
		expect(formatRelativeTime(agoSec(300 * DAY))).toBe('10mo ago');
	});

	test('years bucket', () => {
		expect(formatRelativeTime(agoSec(400 * DAY))).toBe('1y ago');
		expect(formatRelativeTime(agoSec(800 * DAY))).toBe('2y ago');
	});
});

describe('formatRelativeTime — input forms & edges', () => {
	test('accepts a Date, an ISO string, and an epoch-ms number equivalently', () => {
		const d = agoSec(5 * MIN);
		expect(formatRelativeTime(d)).toBe('5m ago');
		expect(formatRelativeTime(d.toISOString())).toBe('5m ago');
		expect(formatRelativeTime(d.getTime())).toBe('5m ago');
	});

	test('a future timestamp reads "in the future"', () => {
		expect(formatRelativeTime(new Date(Date.now() + 60_000))).toBe('in the future');
	});

	test('an unparseable / NaN date returns empty string (no crash)', () => {
		expect(formatRelativeTime('garbage')).toBe('');
		expect(formatRelativeTime(new Date('not-a-date'))).toBe('');
		expect(formatRelativeTime(NaN)).toBe('');
		expect(formatRelativeTime(undefined as unknown as string)).toBe('');
	});
});
