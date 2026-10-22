/**
 * Apply a saved order to a list of items.
 *
 * Keys the user no longer has (a removed menu entry, an environment they lost
 * access to) are dropped. Items missing from the saved order - a new release's
 * menu entry, an environment added after the order was saved - are inserted
 * right after their nearest preceding sibling from the incoming list, so they
 * land where the unordered list would have put them rather than at the end.
 */
export function applyOrder<T extends object>(
	items: readonly T[],
	order: readonly (string | number)[],
	key: (item: T) => string | number
): T[] {
	// A repeated key would put the same item in the list twice, and a keyed {#each}
	// throws on a duplicate - so the order is deduped before anything reads it.
	const byKey = new Map(items.map((item) => [key(item), item]));
	const result = [...new Set(order)].filter((k) => byKey.has(k)).map((k) => byKey.get(k)!);

	items.forEach((item, i) => {
		if (result.includes(item)) return;
		let at = 0;
		for (let j = i - 1; j >= 0; j--) {
			const k = result.indexOf(items[j]);
			if (k !== -1) {
				at = k + 1;
				break;
			}
		}
		result.splice(at, 0, item);
	});

	return result;
}
