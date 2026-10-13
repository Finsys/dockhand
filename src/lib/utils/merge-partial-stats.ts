/**
 * Merge a progressive dashboard `partial` stats update into a tile's existing stats,
 * IN PLACE (Svelte 5 reactivity relies on mutating the existing objects).
 *
 * The dashboard stats stream is re-opened periodically (the 30s refresh, a reconnect,
 * a tab-visibility resume). Each re-open starts with a SKELETON partial: every data
 * section (containers, images, volumes, ...) is a zeroed placeholder flagged
 * `loading[section] = true`, filled in by a later partial. A naive deep-merge lets
 * those placeholder zeros overwrite the real counts a populated tile already shows -
 * and on a slow/remote env the follow-up partial can lag or be lost, leaving the tile
 * stuck at zero even though the environment is healthy.
 *
 * Rule: skip a section's payload while its own `loading` flag is true (keep the prior
 * value); still apply the `loading` object itself so the spinner shows. A section with
 * no loading flag, or `loading:false`, is real data and is merged normally. On the very
 * first load the tile's skeleton already shows zeros, so skipping the placeholder is a
 * no-op there - the real partial (loading:false) fills it.
 */
export function mergePartialStats(
	existing: Record<string, any>,
	partial: Record<string, any>
): void {
	const loadingFlags = (partial.loading || {}) as Record<string, boolean>;
	for (const [key, value] of Object.entries(partial)) {
		if (value === undefined || key === 'id') continue;
		if (loadingFlags[key] === true) continue; // skeleton placeholder - keep prior data
		const current = existing[key];
		if (
			current && typeof current === 'object' && !Array.isArray(current) &&
			value && typeof value === 'object' && !Array.isArray(value)
		) {
			Object.assign(current, value);
		} else {
			existing[key] = value;
		}
	}
}

/**
 * The subset of a `partial` update that should reach the store, dropping placeholder
 * sections (same rule as mergePartialStats) but always keeping `loading`. Returns a new
 * object; does not mutate the input.
 */
export function definedPartialForStore(
	partial: Record<string, any>
): Record<string, any> {
	const loadingFlags = (partial.loading || {}) as Record<string, boolean>;
	const out: Record<string, any> = {};
	for (const [key, value] of Object.entries(partial)) {
		if (value === undefined) continue;
		if (key !== 'loading' && loadingFlags[key] === true) continue;
		out[key] = value;
	}
	return out;
}
