/**
 * The two I/O grid columns (Disk I/O, Net I/O) each hold two metrics, so a header
 * click cycles through all four (metric, direction) states rather than the usual
 * asc/desc toggle (#1111). Pure so it can be unit-tested and shared by the containers
 * and stacks lists.
 */

export type IoSortState<F extends string> = { field: F; direction: 'asc' | 'desc' };

/**
 * Given a column's ordered cycle and the current sort, return the next state.
 * If the current sort is not on this column, start at the first cycle entry
 * (read desc / rx desc - "biggest first" is the useful default for hunting hogs).
 */
export function nextIoSortState<F extends string>(
	cycle: IoSortState<F>[],
	current: { field: F; direction: 'asc' | 'desc' }
): IoSortState<F> {
	const idx = cycle.findIndex((s) => s.field === current.field && s.direction === current.direction);
	if (idx === -1) return cycle[0];
	return cycle[(idx + 1) % cycle.length];
}
