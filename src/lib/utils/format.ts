import { parseTimestamp } from './date-format';

/**
 * Format a byte count into a human-readable string.
 */
export function formatBytes(bytes: number, decimals = 1): string {
	if (bytes === 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : decimals)} ${units[i]}`;
}

/**
 * Compact byte format for grids: 1.2K, 500M, 2.1G
 */
export function formatBytesCompact(bytes: number, decimals = 1): string {
	if (bytes === 0) return '0B';
	const units = ['B', 'K', 'M', 'G', 'T'];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : decimals)}${units[i]}`;
}

/**
 * Make a long single-line error readable by putting each `[NNNN]` log marker on
 * its own line. Scanner/CLI output (grype, trivy, restic) crams a whole log
 * stream into one line prefixed by numeric markers like `[0026]`; splitting on
 * those turns the wall of text into one line per log entry.
 *
 * Only NUMERIC brackets are split — `[]` (an empty compose field path such as
 * `environment.[]`) is left attached so a field name is never torn in half.
 */
export function formatErrorLines(msg: string | null | undefined): string {
	if (!msg) return '';
	return msg.replace(/\s*(\[\d+\])/g, '\n$1').trim();
}

/**
 * Compact relative time like "just now", "5m ago", "2d ago", "3mo ago". Returns ''
 * for an unparseable/NaN date and "in the future" for a timestamp ahead of now.
 * Kept in this import-light module so it is unit-testable; stores/settings re-exports it.
 *
 * Uses parseTimestamp so a naive server timestamp (PG `timestamp without time
 * zone`, e.g. "2026-08-30 20:36:11.534") is read as UTC instead of the
 * browser's local zone - see date-format.ts and #1183. Every caller of this
 * function passes exactly that kind of raw server value alongside
 * formatDateTime(), which already goes through parseTimestamp(); this kept
 * the two out of sync until now.
 */
export function formatRelativeTime(date: Date | string | number): string {
	const d = parseTimestamp(date);
	const ms = d.getTime();
	if (isNaN(ms)) return '';
	const sec = Math.round((Date.now() - ms) / 1000);
	if (sec < 0) return 'in the future';
	if (sec < 45) return 'just now';
	const min = Math.round(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.round(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.round(hr / 24);
	if (day < 30) return `${day}d ago`;
	const mo = Math.round(day / 30);
	if (mo < 12) return `${mo}mo ago`;
	return `${Math.round(mo / 12)}y ago`;
}
