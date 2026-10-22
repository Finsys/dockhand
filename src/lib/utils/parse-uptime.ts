/**
 * Parse a human-readable relative time ("2 hours", "45 seconds", "Less than a
 * second") into seconds, for sorting containers by uptime. Pure; unit-tested.
 *
 * Only the literal "less than a second" collapses to 1s - a value like "45 seconds"
 * must keep its real magnitude so sub-minute uptimes sort against each other (#1395).
 */
export function parseTimeStringToSeconds(timeStr: string): number {
	const str = timeStr.toLowerCase();

	// Docker's HumanDuration emits three phrasings with no digit in them, so the
	// numeric match below cannot see any of them: "Less than a second", "About a
	// minute", and "About an hour" (a duration that rounds to exactly one hour).
	if (str.includes('less than a second')) return 1;
	if (str.includes('less than a minute') || str.includes('about a minute')) return 60;
	if (str.includes('about an hour')) return 3600;

	const match = str.match(/(\d+)\s*(second|minute|hour|day|week|month|year)/);
	if (!match) return 0;

	const value = parseInt(match[1], 10);
	const unit = match[2];

	switch (unit) {
		case 'second': return value;
		case 'minute': return value * 60;
		case 'hour': return value * 3600;
		case 'day': return value * 86400;
		case 'week': return value * 604800;
		case 'month': return value * 2592000;
		case 'year': return value * 31536000;
		default: return 0;
	}
}
