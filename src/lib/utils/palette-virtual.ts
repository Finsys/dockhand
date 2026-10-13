// Pure fixed-height virtualization math for the command palette list. Rows have one of two
// heights (item vs group header); a prefix-sum offsets array + binary search gives the
// visible window in O(log n). Import-light so it's unit-testable without the DOM.

/** Cumulative top offset of each row plus a final total. `heights[i]` is row i's height. */
export function buildOffsets(heights: number[]): number[] {
	const o = new Array<number>(heights.length + 1);
	o[0] = 0;
	for (let i = 0; i < heights.length; i++) o[i + 1] = o[i] + heights[i];
	return o;
}

/**
 * Index of the last row whose top offset is <= y. Binary search into `offsets` (length
 * rows+1). Clamps: y below 0 -> 0; y past the end -> the last row. Returns 0 for an empty
 * list.
 */
export function rowAtOffset(offsets: number[], y: number): number {
	const rows = offsets.length - 1;
	if (rows <= 0) return 0;
	let lo = 0, hi = rows - 1, ans = 0;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (offsets[mid] <= y) {
			ans = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return ans;
}

/** The [start, end) row window to render for a viewport, padded by `buffer` rows. */
export function visibleRange(
	offsets: number[],
	scrollTop: number,
	viewportH: number,
	buffer: number
): { start: number; end: number } {
	const rows = offsets.length - 1;
	if (rows <= 0) return { start: 0, end: 0 };
	const start = Math.max(0, rowAtOffset(offsets, scrollTop) - buffer);
	const end = Math.min(rows, rowAtOffset(offsets, scrollTop + viewportH) + buffer + 1);
	return { start, end };
}
