/**
 * UI date/time formatter timezone handling (#1183).
 *
 * Tests the pure helpers extracted to $lib/utils/date-format. The store wrapper
 * in $lib/stores/settings.ts just plugs the user's cached preferences into
 * these helpers, so covering the helpers covers the bug.
 *
 * Run with: bun test tests/unit/settings-formatters.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
	buildFormatters,
	formatDatePartWith,
	formatTimePartWith,
	type DateFormat,
	type TimeFormat
} from '../src/lib/utils/date-format';

// 14:30:45 UTC on the summer solstice — chosen so:
//  - Asia/Dhaka shifts forward (no DST there) to 20:30:45
//  - America/New_York is on DST (UTC−4) → 10:30:45
//  - Date stays on the same calendar day in all the test zones
const SAMPLE = new Date('2026-06-21T14:30:45Z');

function format(d: Date, tz: string, dateFormat: DateFormat, timeFormat: TimeFormat, includeSeconds = true): string {
	const f = buildFormatters(tz);
	return `${formatDatePartWith(d, f.date, dateFormat)} ${formatTimePartWith(d, f.time, timeFormat, includeSeconds)}`;
}

describe('timezone handling', () => {
	test('UTC renders at the unshifted wall-clock', () => {
		expect(format(SAMPLE, 'UTC', 'DD.MM.YYYY', '24h')).toBe('21.06.2026 14:30:45');
	});

	test('Asia/Dhaka shifts by +06:00 (the #1183 case)', () => {
		expect(format(SAMPLE, 'Asia/Dhaka', 'DD.MM.YYYY', '24h')).toBe('21.06.2026 20:30:45');
	});

	test('America/New_York shifts by −04:00 (DST)', () => {
		expect(format(SAMPLE, 'America/New_York', 'DD.MM.YYYY', '24h')).toBe('21.06.2026 10:30:45');
	});

	test('Asia/Tokyo shifts by +09:00', () => {
		expect(format(SAMPLE, 'Asia/Tokyo', 'DD.MM.YYYY', '24h')).toBe('21.06.2026 23:30:45');
	});

	test('seconds-off variant drops seconds but still respects tz', () => {
		const f = buildFormatters('Asia/Dhaka');
		const date = formatDatePartWith(SAMPLE, f.date, 'DD.MM.YYYY');
		const time = formatTimePartWith(SAMPLE, f.time, '24h', false);
		expect(`${date} ${time}`).toBe('21.06.2026 20:30');
	});

	test('empty timezone string falls back to runtime local (no crash)', () => {
		const f = buildFormatters('');
		// Don't assert the exact value — depends on test runner's locale — just
		// confirm it produces a well-shaped date+time string in DD.MM.YYYY HH:MM:SS.
		const out = `${formatDatePartWith(SAMPLE, f.date, 'DD.MM.YYYY')} ${formatTimePartWith(SAMPLE, f.time, '24h', true)}`;
		expect(out).toMatch(/^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$/);
	});
});

describe('date format preservation', () => {
	test('DD.MM.YYYY', () => {
		expect(format(SAMPLE, 'UTC', 'DD.MM.YYYY', '24h')).toBe('21.06.2026 14:30:45');
	});

	test('DD/MM/YYYY', () => {
		expect(format(SAMPLE, 'UTC', 'DD/MM/YYYY', '24h')).toBe('21/06/2026 14:30:45');
	});

	test('MM/DD/YYYY', () => {
		expect(format(SAMPLE, 'UTC', 'MM/DD/YYYY', '24h')).toBe('06/21/2026 14:30:45');
	});

	test('YYYY-MM-DD', () => {
		expect(format(SAMPLE, 'UTC', 'YYYY-MM-DD', '24h')).toBe('2026-06-21 14:30:45');
	});
});

describe('12h/24h handling under tz shift', () => {
	test('12h format converts noon-shifted values correctly', () => {
		// 14:30 UTC → 10:30 EDT
		expect(format(SAMPLE, 'America/New_York', 'MM/DD/YYYY', '12h')).toBe('06/21/2026 10:30:45 AM');
	});

	test('12h format flips to PM after a westbound shift past noon', () => {
		// 14:30 UTC → 20:30 BDT
		expect(format(SAMPLE, 'Asia/Dhaka', 'MM/DD/YYYY', '12h')).toBe('06/21/2026 8:30:45 PM');
	});

	test('midnight in 12h format renders as 12:XX AM', () => {
		const midnight = new Date('2026-06-21T00:15:30Z');
		expect(format(midnight, 'UTC', 'MM/DD/YYYY', '12h')).toBe('06/21/2026 12:15:30 AM');
	});

	test('noon in 12h format renders as 12:XX PM', () => {
		const noon = new Date('2026-06-21T12:00:00Z');
		expect(format(noon, 'UTC', 'MM/DD/YYYY', '12h')).toBe('06/21/2026 12:00:00 PM');
	});
});

describe('day-roll across international date line', () => {
	test('UTC+14 rolls a late-day UTC timestamp to the next calendar day', () => {
		const f = buildFormatters('Pacific/Kiritimati'); // UTC+14
		const lateUtc = new Date('2026-06-21T23:30:00Z'); // → 2026-06-22 13:30 local
		expect(formatDatePartWith(lateUtc, f.date, 'DD.MM.YYYY')).toBe('22.06.2026');
	});

	test('UTC-10 rolls an early-day UTC timestamp to the previous calendar day', () => {
		const f = buildFormatters('Pacific/Honolulu'); // UTC-10
		const earlyUtc = new Date('2026-06-21T05:00:00Z'); // → 2026-06-20 19:00 local
		expect(formatDatePartWith(earlyUtc, f.date, 'DD.MM.YYYY')).toBe('20.06.2026');
	});
});
