/**
 * Pure query-string builder for Docker's `POST /build/prune`, kept import-free so a
 * bun unit test can cover the one non-mechanical decision: which disk-keep parameter
 * to send for the daemon's API version.
 *
 * `reserved-space` exists from API 1.48; before that the same field is `keep-storage`
 * (deprecated from 1.48, removed in 1.52). Sending `reserved-space` to a pre-1.48 daemon
 * is silently ignored, so a wrong choice would prune everything the operator meant to
 * keep - hence the version gate.
 */

export interface BuildCachePruneOptions {
	/** Prune all cache, not only dangling (Docker default is dangling-only). */
	all?: boolean;
	/** Age filter, e.g. "336h" or "24h" - a Go duration or timestamp, passed in `filters.until`. */
	until?: string;
	/** Bytes of cache to keep. Mapped to reserved-space (API >= 1.48) or keep-storage (below). */
	reservedSpace?: number;
}

/** True when the negotiated API version is >= 1.48 (where reserved-space replaced keep-storage). */
export function usesReservedSpace(apiVersion: string | null | undefined): boolean {
	if (!apiVersion) return false; // unknown version: use the long-standing keep-storage
	const m = /^(\d+)\.(\d+)/.exec(apiVersion.trim());
	if (!m) return false;
	const major = Number(m[1]);
	const minor = Number(m[2]);
	return major > 1 || (major === 1 && minor >= 48);
}

/**
 * Build the query string (no leading `?`) for `/build/prune`. Returns an empty string
 * when no option narrows the default dangling-only prune.
 */
export function buildBuildPruneQuery(
	opts: BuildCachePruneOptions,
	apiVersion: string | null | undefined
): string {
	const params = new URLSearchParams();

	if (opts.all) params.set('all', 'true');

	if (opts.until && opts.until.trim() !== '') {
		params.set('filters', JSON.stringify({ until: [opts.until.trim()] }));
	}

	if (typeof opts.reservedSpace === 'number' && Number.isFinite(opts.reservedSpace) && opts.reservedSpace > 0) {
		const key = usesReservedSpace(apiVersion) ? 'reserved-space' : 'keep-storage';
		params.set(key, String(Math.floor(opts.reservedSpace)));
	}

	return params.toString();
}
