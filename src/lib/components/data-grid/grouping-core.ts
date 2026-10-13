// Pure grouping logic for the DataGrid. Kept import-light + unit-tested so the
// grid component stays glue. A row's group descriptor is supplied by the caller
// (e.g. containers group by their tag combination); this module only partitions
// and orders, it does not know about tags.

/** What `groupBy(item)` returns for one row. `null` = ungrouped (the trailing group). */
export interface GroupDescriptor {
	/** Stable identity of the group (rows with the same key share a group). */
	key: string;
	/** Human label shown in the header. */
	label: string;
	/** Optional accent colour (hex) for the header + left band. */
	color?: string | null;
	/** Optional icon names shown in the header (e.g. one per tag in the combo). */
	icons?: (string | null)[];
	/**
	 * Sort weight for ordering groups against each other. Lower comes first; equal
	 * weights fall back to label order. Ungrouped rows use +Infinity so they always
	 * trail. Defaults to 0.
	 */
	order?: number;
}

export interface DataGridGroup<T> {
	key: string;
	label: string;
	color: string | null;
	icons: (string | null)[];
	items: T[];
}

/** Sentinel key for the "no group" bucket (rows whose groupBy returned null). */
export const UNGROUPED_KEY = '__ungrouped__';

/**
 * Partition `data` into ordered groups. Row order WITHIN a group is preserved
 * (the caller pre-sorts `data`), so grouping composes with column sorting.
 * Group order: by `order` weight, then label (case-insensitive), then key, so it
 * does not depend on row order. The ungrouped bucket always trails.
 */
export function groupData<T>(
	data: T[],
	groupBy: (item: T) => GroupDescriptor | null,
	ungroupedLabel = 'Untagged'
): DataGridGroup<T>[] {
	const groups = new Map<string, DataGridGroup<T> & { order: number }>();

	for (const item of data) {
		const desc = groupBy(item);
		const key = desc ? desc.key : UNGROUPED_KEY;
		let g = groups.get(key);
		if (!g) {
			g = {
				key,
				label: desc ? desc.label : ungroupedLabel,
				color: desc?.color ?? null,
				icons: desc?.icons ?? [],
				items: [],
				order: desc ? (desc.order ?? 0) : Number.POSITIVE_INFINITY
			};
			groups.set(key, g);
		}
		g.items.push(item);
	}

	return [...groups.values()]
		.sort(
			(a, b) =>
				a.order - b.order ||
				a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }) ||
				(a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
		)
		.map(({ order: _order, ...g }) => g);
}
