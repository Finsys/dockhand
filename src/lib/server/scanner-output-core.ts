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

/** A bare image ID: `sha256:<64 hex>` or just the 64-hex digest. */
function isBareDigest(ref: string): boolean {
	return /^(sha256:)?[0-9a-f]{64}$/.test(ref);
}

/** A Dockhand-internal temporary tag (`...-dockhand-pending` / `-dockhand-update`) applied
 * during the safe auto-update scan - a poor label to show a user, preferred only if no real
 * tag exists. */
function isTempTag(tag: string): boolean {
	return /-dockhand-(pending|update)(:|$)/.test(tag);
}

/**
 * The human-readable name a scan should record and notify with.
 *
 * A scan is driven by whatever ref the caller passed, and the auto-update path passes
 * either a bare image ID - which would show as `Image "sha256:..." has N critical` - or
 * the temporary tag it applied while scanning, which outlives the scan in the dashboard
 * long after the image has been retagged. Both are poor labels, so a real RepoTag from
 * the inspect wins over either. Any other ref is the caller's own name and is kept.
 */
export function pickScanDisplayName(imageRef: string, repoTags: string[] | undefined | null): string {
	if (!isBareDigest(imageRef) && !isTempTag(imageRef)) return imageRef;
	const tags = (repoTags || []).filter((t) => typeof t === 'string' && t && t !== '<none>:<none>');
	const realTag = tags.find((t) => !isTempTag(t));
	// Nothing better to offer: a genuinely untagged image leaves only what came in.
	return realTag ?? tags[0] ?? imageRef;
}
