/**
 * Time texts in the UI language.
 *
 * The helpers in $lib/utils (format.ts, container-status.ts) stay English because
 * their unit tests pin that output; these wrappers reuse their logic and only
 * change the wording.
 */
import { m } from '$lib/paraglide/messages.js';
import { formatUptime as formatUptimeEnglish } from '$lib/utils/container-status';
import { relativeTimeParts } from '$lib/utils/format';

/** Compact relative time ("5m ago" / "vor 5 Min."), same rounding as utils/format. */
export function formatRelativeTime(date: Date | string | number): string {
	const parts = relativeTimeParts(date);
	if (!parts) return '';
	switch (parts.unit) {
		case 'future':
			return m.time_in_future();
		case 'now':
			return m.time_just_now();
		case 'minutes':
			return m.time_minutes_ago({ count: parts.count });
		case 'hours':
			return m.time_hours_ago({ count: parts.count });
		case 'days':
			return m.time_days_ago({ count: parts.count });
		case 'months':
			return m.time_months_ago({ count: parts.count });
		case 'years':
			return m.time_years_ago({ count: parts.count });
	}
}

/**
 * Docker words durations with go-units HumanDuration ("Less than a second",
 * "About a minute", "3 hours", "2 weeks", …), optionally followed by " ago".
 * Anything else is returned unchanged.
 */
const DOCKER_DURATION = /^(less than a second|about a minute|about an hour|(\d+) (second|minute|hour|day|week|month|year)s?)( ago)?$/i;

export function translateDockerDuration(text: string): string {
	const match = text.trim().match(DOCKER_DURATION);
	if (!match) return text;
	const [, phrase, digits, unit, ago] = match;
	const count = Number(digits);
	const key = digits ? unit.toLowerCase() : phrase.toLowerCase();
	if (ago) {
		switch (key) {
			case 'less than a second': return m.duration_ago_less_than_second();
			case 'about a minute': return m.duration_ago_about_minute();
			case 'about an hour': return m.duration_ago_about_hour();
			case 'second': return m.duration_ago_seconds({ count });
			case 'minute': return m.duration_ago_minutes({ count });
			case 'hour': return m.duration_ago_hours({ count });
			case 'day': return m.duration_ago_days({ count });
			case 'week': return m.duration_ago_weeks({ count });
			case 'month': return m.duration_ago_months({ count });
			case 'year': return m.duration_ago_years({ count });
		}
	}
	switch (key) {
		case 'less than a second': return m.duration_less_than_second();
		case 'about a minute': return m.duration_about_minute();
		case 'about an hour': return m.duration_about_hour();
		case 'second': return m.duration_seconds({ count });
		case 'minute': return m.duration_minutes({ count });
		case 'hour': return m.duration_hours({ count });
		case 'day': return m.duration_days({ count });
		case 'week': return m.duration_weeks({ count });
		case 'month': return m.duration_months({ count });
		case 'year': return m.duration_years({ count });
	}
	return text;
}

/** The grid's Uptime text (utils/container-status) in the UI language. */
export function formatUptime(status: string): string {
	return translateDockerDuration(formatUptimeEnglish(status));
}
