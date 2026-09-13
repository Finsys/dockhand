import { describe, test, expect } from 'bun:test';
import { currentDateInTimezone, dayBoundaryToUtcISO, parseTimestamp, buildFormatters, formatDatePartWith, formatTimePartWith } from '../src/lib/utils/date-format';

// Activity/audit date filters treat 'YYYY-MM-DD' as a calendar day in the
// configured display timezone; these helpers turn that into UTC instants
// comparable against UTC-stored timestamps (#1269).

describe('dayBoundaryToUtcISO', () => {
	test('UTC start of day is midnight UTC', () => {
		expect(dayBoundaryToUtcISO('2026-07-09', 'UTC', false)).toBe('2026-07-09T00:00:00.000Z');
	});

	test('UTC end of day is 23:59:59.999 UTC', () => {
		expect(dayBoundaryToUtcISO('2026-07-09', 'UTC', true)).toBe('2026-07-09T23:59:59.999Z');
	});

	test('positive offset zone: local midnight is the previous day in UTC (Sydney, UTC+10)', () => {
		expect(dayBoundaryToUtcISO('2026-07-09', 'Australia/Sydney', false)).toBe('2026-07-08T14:00:00.000Z');
	});

	test('positive offset zone: local end of day (Sydney, UTC+10)', () => {
		expect(dayBoundaryToUtcISO('2026-07-09', 'Australia/Sydney', true)).toBe('2026-07-09T13:59:59.999Z');
	});

	test('negative offset zone: local midnight is later the same day in UTC (New York, UTC-4 in summer)', () => {
		expect(dayBoundaryToUtcISO('2026-07-09', 'America/New_York', false)).toBe('2026-07-09T04:00:00.000Z');
	});

	test('negative offset zone: local end of day crosses into the next UTC day (New York)', () => {
		expect(dayBoundaryToUtcISO('2026-07-09', 'America/New_York', true)).toBe('2026-07-10T03:59:59.999Z');
	});

	test('DST-aware: Warsaw is UTC+2 in summer, UTC+1 in winter', () => {
		expect(dayBoundaryToUtcISO('2026-07-09', 'Europe/Warsaw', false)).toBe('2026-07-08T22:00:00.000Z');
		expect(dayBoundaryToUtcISO('2026-01-09', 'Europe/Warsaw', false)).toBe('2026-01-08T23:00:00.000Z');
	});

	test('DST spring-forward day: midnight still resolves to the pre-transition offset (Warsaw 2026-03-29)', () => {
		// Clocks jump 02:00 -> 03:00 that day; midnight itself is still UTC+1
		expect(dayBoundaryToUtcISO('2026-03-29', 'Europe/Warsaw', false)).toBe('2026-03-28T23:00:00.000Z');
		// End of the same day is already UTC+2
		expect(dayBoundaryToUtcISO('2026-03-29', 'Europe/Warsaw', true)).toBe('2026-03-29T21:59:59.999Z');
	});

	test('DST fall-back day: end of day resolves to the post-transition offset (Warsaw 2026-10-25)', () => {
		// Clocks fall back 03:00 -> 02:00; midnight is UTC+2, end of day UTC+1
		expect(dayBoundaryToUtcISO('2026-10-25', 'Europe/Warsaw', false)).toBe('2026-10-24T22:00:00.000Z');
		expect(dayBoundaryToUtcISO('2026-10-25', 'Europe/Warsaw', true)).toBe('2026-10-25T22:59:59.999Z');
	});

	test('half-hour offset zone (India, UTC+5:30)', () => {
		expect(dayBoundaryToUtcISO('2026-07-09', 'Asia/Kolkata', false)).toBe('2026-07-08T18:30:00.000Z');
	});

	test('falsy timezone falls back to the runtime local zone', () => {
		const expected = new Date(2026, 6, 9, 0, 0, 0, 0).toISOString();
		expect(dayBoundaryToUtcISO('2026-07-09', undefined, false)).toBe(expected);
	});

	test('start boundary is inclusive of the first event of the day, end of the last', () => {
		const from = dayBoundaryToUtcISO('2026-07-09', 'Australia/Sydney', false);
		const to = dayBoundaryToUtcISO('2026-07-09', 'Australia/Sydney', true);
		// Event at 09:00 Sydney time on 2026-07-09 = 2026-07-08T23:00:00Z:
		// "tomorrow in UTC+0"? No - but late-evening Sydney events ARE next-day UTC:
		const lateEvening = '2026-07-09T10:30:00.000Z'; // 20:30 Sydney
		expect(lateEvening >= from && lateEvening <= to).toBe(true);
		// The #1269 repro: event just after Sydney midnight, previous day in UTC
		const justAfterMidnight = '2026-07-08T14:05:00.000Z'; // 00:05 Sydney on the 9th
		expect(justAfterMidnight >= from && justAfterMidnight <= to).toBe(true);
		// Event before Sydney midnight is excluded
		const beforeMidnight = '2026-07-08T13:55:00.000Z'; // 23:55 Sydney on the 8th
		expect(beforeMidnight >= from).toBe(false);
	});
});

describe('currentDateInTimezone', () => {
	test('returns YYYY-MM-DD', () => {
		expect(currentDateInTimezone('UTC')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(currentDateInTimezone()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	test('UTC matches toISOString date part', () => {
		// Sample twice to avoid a flake if the test straddles UTC midnight
		const before = new Date().toISOString().slice(0, 10);
		const result = currentDateInTimezone('UTC');
		const after = new Date().toISOString().slice(0, 10);
		expect([before, after]).toContain(result);
	});

	test('fixed-offset zone matches manual offset arithmetic (Kiritimati, UTC+14, no DST)', () => {
		const before = new Date(Date.now() + 14 * 3_600_000).toISOString().slice(0, 10);
		const result = currentDateInTimezone('Pacific/Kiritimati');
		const after = new Date(Date.now() + 14 * 3_600_000).toISOString().slice(0, 10);
		expect([before, after]).toContain(result);
	});
});

// #1183: PG `timestamp without time zone` hands back a NAIVE string (no Z); the
// browser must NOT read it as local time. Asserting on .toISOString() keeps the
// test independent of the CI host's own timezone.
describe('parseTimestamp', () => {
	test('naive PG string (space, no Z) is read as UTC', () => {
		expect(parseTimestamp('2026-08-08 15:22:19.705').toISOString()).toBe('2026-08-08T15:22:19.705Z');
	});

	test('naive PG string without fractional seconds is read as UTC', () => {
		expect(parseTimestamp('2026-08-08 15:22:19').toISOString()).toBe('2026-08-08T15:22:19.000Z');
	});

	test('ISO string with Z is left untouched', () => {
		expect(parseTimestamp('2026-08-08T15:22:19.705Z').toISOString()).toBe('2026-08-08T15:22:19.705Z');
	});

	test('ISO string with +00:00 offset is preserved (not double-appended)', () => {
		expect(parseTimestamp('2026-08-08T15:22:19+00:00').toISOString()).toBe('2026-08-08T15:22:19.000Z');
	});

	test('ISO string with a real +06:00 offset resolves to the right UTC instant', () => {
		expect(parseTimestamp('2026-08-08T21:22:19+06:00').toISOString()).toBe('2026-08-08T15:22:19.000Z');
	});

	test('the DATE-part hyphen is not mistaken for an offset (naive -> UTC)', () => {
		expect(parseTimestamp('2026-08-08T15:22:19').toISOString()).toBe('2026-08-08T15:22:19.000Z');
	});

	test('a Date is returned as-is', () => {
		const d = new Date('2026-08-08T15:22:19.705Z');
		expect(parseTimestamp(d)).toBe(d);
	});

	test('a numeric epoch is parsed as-is', () => {
		const ms = Date.UTC(2026, 7, 8, 15, 22, 19);
		expect(parseTimestamp(ms).toISOString()).toBe('2026-08-08T15:22:19.000Z');
	});

	// Garbage in must never throw - the formatters render hundreds of rows.
	// bigint is the sharp edge: `new Date(10n)` throws TypeError, so it must be caught.
	test('garbage inputs yield an Invalid Date, never a throw', () => {
		for (const junk of [null, undefined, '', '   ', 'not-a-date', '2026-13-99', {}, [], NaN, 10n, Symbol('x')]) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			let d: Date;
			expect(() => { d = parseTimestamp(junk as any); }).not.toThrow();
			// @ts-expect-error d is assigned above
			expect(Number.isNaN(d.getTime())).toBe(true);
		}
	});
});

// A single unparseable timestamp must degrade to a placeholder, not throw
// RangeError out of Intl.formatToParts and blank the whole list (#1183 follow-up).
describe('formatters survive Invalid Date', () => {
	const { date, time } = buildFormatters('UTC');
	for (const junk of [null, undefined, '', 'not-a-date', '2026-13-99', NaN]) {
		test(`date part is a placeholder for ${JSON.stringify(junk)}`, () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const d = parseTimestamp(junk as any);
			expect(() => formatDatePartWith(d, date, 'DD.MM.YYYY')).not.toThrow();
			expect(formatDatePartWith(d, date, 'DD.MM.YYYY')).toBe('-');
		});
		test(`time part is a placeholder for ${JSON.stringify(junk)}`, () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const d = parseTimestamp(junk as any);
			expect(() => formatTimePartWith(d, time, '24h', true)).not.toThrow();
			expect(formatTimePartWith(d, time, '24h', true)).toBe('-');
		});
	}
});
