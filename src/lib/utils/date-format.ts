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

export function formatDatePartWith(d: Date, dateFormatter: Intl.DateTimeFormat, dateFormat: DateFormat): string {
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
