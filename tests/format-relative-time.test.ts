/**
 * formatRelativeTime — compact "N ago" formatting with null/NaN/future safety.
 * Pure function in the import-light utils/format module (stores/settings re-exports it).
 *
 * Run with: bun test tests/unit/format-relative-time.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
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

// #1183 follow-up (reported live: a deploy from ~2 minutes ago showed "2h ago"):
// the server hands back a NAIVE timestamp (PG `timestamp without time zone`,
// e.g. "2026-08-30 20:36:11.534" - space separator, no "Z"/offset). Every
// caller of formatRelativeTime passes exactly that value, right alongside
// formatDateTime() which already reads it as UTC via parseTimestamp() (see
// date-format-tz.test.ts). formatRelativeTime used to parse it with a bare
// `new Date(...)`, which treats a zone-less string as browser-local time -
// correct only when the browser happens to run in UTC, which is exactly why
// this stayed invisible in a UTC test browser.
//
// TZ is forced to a non-UTC zone for this block only, so the bug reproduces
// regardless of the host/CI timezone. Restored in afterAll: bun runs every
// test file in one process, so a dangling override would leak into whichever
// file happens to run next.
describe('formatRelativeTime — a naive server timestamp is read as UTC, not local time', () => {
	const originalTZ = process.env.TZ;

	beforeAll(() => {
		process.env.TZ = 'America/New_York'; // UTC-4 in August - deliberately not UTC
	});

	afterAll(() => {
		if (originalTZ === undefined) delete process.env.TZ;
		else process.env.TZ = originalTZ;
	});

	// Same instant in two forms: a proper zoned ISO string, and the naive
	// space-separated form Drizzle hands back for a `timestamp without time
	// zone` column. Deriving the expectation from the zoned form (rather than
	// hardcoding a bucket string) keeps the assertion meaningful independent
	// of whichever zone the suite happens to run under.
	const naiveFrom = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '');

	test('a naive PG-style string reports the same age as its zoned equivalent (5m ago)', () => {
		const instant = new Date(Date.now() - 5 * 60 * 1000);
		expect(formatRelativeTime(naiveFrom(instant))).toBe(formatRelativeTime(instant.toISOString()));
		expect(formatRelativeTime(naiveFrom(instant))).toBe('5m ago');
	});

	test('a two-minute-old naive deploy timestamp reads "2m ago" - the reported bug', () => {
		// Under the bug, "20:36:11" gets read as 20:36:11 America/New_York and
		// re-anchored 4h later in UTC than the true instant, so
		// Date.now() - ms goes negative and this would report "in the future"
		// instead of "2m ago".
		const instant = new Date(Date.now() - 2 * 60 * 1000);
		expect(formatRelativeTime(naiveFrom(instant))).toBe('2m ago');
	});

	test('a naive timestamp from several hours ago still reads the correct bucket', () => {
		const instant = new Date(Date.now() - 3 * 60 * 60 * 1000);
		expect(formatRelativeTime(naiveFrom(instant))).toBe('3h ago');
	});
});
