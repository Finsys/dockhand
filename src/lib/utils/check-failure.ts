/**
 * Failed update checks grouped by their exact message, in order of first appearance,
 * so many containers failing for one reason read as one entry.
 */
export function groupFailuresByMessage<T extends { error: string }>(failed: T[]): { error: string; items: T[] }[] {
	const groups = new Map<string, T[]>();
	for (const f of failed) {
		const items = groups.get(f.error);
		if (items) items.push(f);
		else groups.set(f.error, [f]);
	}
	return [...groups].map(([error, items]) => ({ error, items }));
}
