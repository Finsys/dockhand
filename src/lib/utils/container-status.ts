/**
 * Read a container's uptime out of its Docker status string, for display and for
 * sorting. Pure; unit-tested.
 *
 * Both halves deliberately avoid anchoring on a digit. Docker renders durations
 * with go-units HumanDuration, which has three phrasings that contain no number
 * at all ("Less than a second", "About a minute", "About an hour"), so a
 * digit-anchored pattern silently drops them: the column shows a dash and the
 * row sorts as if it had no uptime.
 */
import { parseTimeStringToSeconds } from './parse-uptime';

/** "Up 2 hours (healthy)" -> "2 hours"; the running half of a status. */
const UP_RE = /Up\s+(.+?)(?:\s+\(|$)/i;

/**
 * "Exited (137) About an hour ago" / "Restarting (1) 5 seconds ago" -> the
 * duration. Both non-running shapes share the "(code) <duration> ago" tail, and
 * the code itself is optional. A restarting container is the one an operator
 * sorts by uptime to find, so it must keep its magnitude rather than fall
 * through to the unrecognised case.
 */
const STOPPED_RE = /(?:Exited|Restarting)\s*(?:\([^)]*\))?\s+(.+?)\s+ago/i;

/** The uptime text for the grid's Uptime column, or "-" when the status carries none. */
export function formatUptime(status: string): string {
	if (!status) return '-';
	const up = status.match(UP_RE);
	if (up) return up[1].trim();
	const stopped = status.match(STOPPED_RE);
	if (stopped) return `${stopped[1]} ago`;
	return '-';
}

/**
 * The same uptime as a sortable number of seconds. A running container is
 * positive (longer up = larger); one that has stopped or is restarting goes
 * negative so it sorts after every running container while keeping its real
 * magnitude; a status carrying no duration at all ("Created", "Dead") sorts
 * last.
 */
export function parseUptimeToSeconds(status: string): number {
	if (!status) return -Infinity;
	const up = status.match(UP_RE);
	if (up) return parseTimeStringToSeconds(up[1].trim());
	const stopped = status.match(STOPPED_RE);
	if (stopped) return -parseTimeStringToSeconds(stopped[1]);
	return -Infinity;
}
