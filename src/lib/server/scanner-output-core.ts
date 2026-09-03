/**
 * Pure, side-effect-free helpers for handling scanner (Trivy/Grype) stdout. Kept out of
 * scanner.ts so they can be unit-tested without pulling in docker/db (which break bun test).
 */

/**
 * Bound a large scanner output for logging: keep a head and tail (default 2 KB each) with a
 * marker for the elided middle, so a failed parse of a multi-MB report never floods stderr /
 * the log shipper (#1496). Small outputs pass through unchanged.
 */
export function truncateForLog(output: string, keep = 2048): string {
	if (output.length <= keep * 2) return output;
	const elided = output.length - keep * 2;
	return `${output.slice(0, keep)}\n...[${elided} bytes elided]...\n${output.slice(-keep)}`;
}

/**
 * Classify a scanner output that failed to parse as JSON, to surface a useful error.
 * - 'truncated': a large buffer that does NOT start with `{` is a mid-document fragment - the
 *   head of the JSON was lost to container-log rotation (#1496).
 * - 'cli-error': a short non-JSON output is a genuine error message printed by the scanner CLI.
 * - 'unknown': anything else (e.g. starts with `{` but is still unparseable).
 */
export function classifyUnparseableOutput(output: string): 'truncated' | 'cli-error' | 'unknown' {
	const trimmed = output.trimStart();
	if (output.length > 100_000 && !trimmed.startsWith('{')) return 'truncated';
	const firstLine = trimmed.split('\n', 1)[0].trim();
	if (firstLine && !firstLine.startsWith('{')) return 'cli-error';
	return 'unknown';
}
