/**
 * Pure date/time formatting helpers — no SvelteKit / store imports.
 *
 * settings.ts wraps these with cached preferences and a reactive subscription;
 * keeping the implementation here lets the formatters be unit-tested without
 * dragging in $app/environment or svelte/store.
 */

export type TimeFormat = '12h' | '24h';
export type DateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'DD.MM.YYYY';

export interface DateTimeFormatters {
	date: Intl.DateTimeFormat;
	time: Intl.DateTimeFormat;
}

// A timezone designator at the END of an ISO string: `Z`, or a `+hh:mm` / `-hh:mm`
// offset after the time part. The leading anchor requires a `T` or space + time first
// so the `-` in the DATE part (2026-08-08) never counts as an offset.
const HAS_TZ = /(\d{2}:\d{2}(:\d{2})?(\.\d+)?)(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Parse a server timestamp into a Date. Every timestamp the app stores is UTC
 * (`.toISOString()` on SQLite, PG `NOW()`), but PostgreSQL columns are
 * `timestamp without time zone`, so Drizzle hands back a NAIVE string
 * (`2026-08-08 15:22:19.7`) with no `Z`. `new Date(naive)` would read that as
 * BROWSER-LOCAL time, double-shifting once the formatter re-applies the zone.
 * Treat a zone-less string as UTC; leave Date/number and already-zoned strings alone.
 */
export function parseTimestamp(value: Date | string | number): Date {
	if (value instanceof Date) return value;
	// Anything unparseable becomes Invalid Date, NEVER a throw - the formatters render
	// hundreds of rows and guard on isValidDate, so one bad value degrades to a
	// placeholder instead of blanking the list. `new Date(bigint)` throws TypeError, so
	// the whole body is wrapped.
	try {
		if (value == null) return new Date(NaN); // also catches undefined (== not ===)
		if (typeof value !== 'string') return new Date(value as number);
		const s = value.trim();
		if (!s) return new Date(NaN);
		if (HAS_TZ.test(s)) return new Date(s);
		// Zone-less -> it's UTC. Normalize the space form to ISO and append Z.
		return new Date(s.replace(' ', 'T') + 'Z');
	} catch {
		return new Date(NaN);
	}
}

// Intl.DateTimeFormat construction is expensive; the caller caches one pair per
// timezone and rebuilds only when the timezone setting changes.
export function buildFormatters(timeZone: string | undefined): DateTimeFormatters {
	const tz = timeZone || undefined;
	return {
		date: new Intl.DateTimeFormat('en-GB', {
			timeZone: tz,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit'
		}),
		time: new Intl.DateTimeFormat('en-GB', {
			timeZone: tz,
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hour12: false
		})
	};
}

function pickPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
	return parts.find((p) => p.type === type)?.value ?? '';
}

// Placeholder for an unparseable timestamp. `Intl.formatToParts(Invalid Date)`
// THROWS RangeError, and these formatters render hundreds of rows, so one bad
// value would blank the whole list. Guard here instead.
const INVALID_PLACEHOLDER = '-';

function isValidDate(d: Date): boolean {
	return d instanceof Date && !Number.isNaN(d.getTime());
}

export function formatDatePartWith(d: Date, dateFormatter: Intl.DateTimeFormat, dateFormat: DateFormat): string {
	if (!isValidDate(d)) return INVALID_PLACEHOLDER;
	const parts = dateFormatter.formatToParts(d);
	const day = pickPart(parts, 'day');
	const month = pickPart(parts, 'month');
	const year = pickPart(parts, 'year');

	switch (dateFormat) {
		case 'MM/DD/YYYY':
			return `${month}/${day}/${year}`;
		case 'DD/MM/YYYY':
			return `${day}/${month}/${year}`;
		case 'YYYY-MM-DD':
			return `${year}-${month}-${day}`;
		case 'DD.MM.YYYY':
		default:
			return `${day}.${month}.${year}`;
	}
}

export function formatTimePartWith(
	d: Date,
	timeFormatter: Intl.DateTimeFormat,
	timeFormat: TimeFormat,
	includeSeconds = false
): string {
	if (!isValidDate(d)) return INVALID_PLACEHOLDER;
	const parts = timeFormatter.formatToParts(d);
	const hours = parseInt(pickPart(parts, 'hour'), 10);
	const minutes = pickPart(parts, 'minute');
	const seconds = pickPart(parts, 'second');

	if (timeFormat === '12h') {
		const hour12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
		const ampm = hours >= 12 ? 'PM' : 'AM';
		return includeSeconds
			? `${hour12}:${minutes}:${seconds} ${ampm}`
			: `${hour12}:${minutes} ${ampm}`;
	} else {
		const hour24 = hours.toString().padStart(2, '0');
		return includeSeconds
			? `${hour24}:${minutes}:${seconds}`
			: `${hour24}:${minutes}`;
	}
}

/**
 * Offset of a timezone from UTC (in ms) at a given instant.
 * Positive for zones ahead of UTC (e.g. UTC+2 -> 7_200_000).
 */
function tzOffsetMs(timeZone: string, at: Date): number {
	const dtf = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	});
	const parts = dtf.formatToParts(at);
	const get = (type: Intl.DateTimeFormatPartTypes) =>
		parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
	const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
	// Drop sub-second precision of `at` - formatToParts only has seconds
	return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * Current calendar date in a timezone as 'YYYY-MM-DD'.
 * Falsy timeZone means the browser's local timezone.
 */
export function currentDateInTimezone(timeZone?: string): string {
	const now = new Date();
	if (!timeZone) {
		const y = now.getFullYear();
		const m = String(now.getMonth() + 1).padStart(2, '0');
		const d = String(now.getDate()).padStart(2, '0');
		return `${y}-${m}-${d}`;
	}
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(now);
	const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
	return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * UTC instant (ISO string) of a day boundary in a timezone: midnight for the
 * start of the day, 23:59:59.999 for the end. Used to turn date-only filter
 * values ('YYYY-MM-DD', meaning a day in the user's configured timezone) into
 * timestamps comparable against UTC-stored event times (#1269).
 * Falsy timeZone means the browser's local timezone.
 */
export function dayBoundaryToUtcISO(dateStr: string, timeZone: string | undefined, endOfDay: boolean): string {
	const [y, m, d] = dateStr.split('-').map(Number);
	const h = endOfDay ? 23 : 0;
	const min = endOfDay ? 59 : 0;
	const s = endOfDay ? 59 : 0;
	const ms = endOfDay ? 999 : 0;

	if (!timeZone) {
		return new Date(y, m - 1, d, h, min, s, ms).toISOString();
	}

	const wallClockUtc = Date.UTC(y, m - 1, d, h, min, s, ms);
	// Two passes so DST transitions near the boundary converge on the right offset
	let ts = wallClockUtc;
	for (let i = 0; i < 2; i++) {
		ts = wallClockUtc - tzOffsetMs(timeZone, new Date(ts));
	}
	return new Date(ts).toISOString();
}
