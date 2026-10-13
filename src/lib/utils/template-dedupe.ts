/**
 * Give every template a unique id (mutates + returns the list). Template ids are derived
 * from source+title, so two entries with the same title in one source collide - which makes
 * the client's keyed {#each} throw (each_key_duplicate) and render nothing. Any repeat is
 * suffixed so the ids stay stable-ish but never duplicate. Pure, import-light, unit-tested.
 */
export function dedupeTemplateIds<T extends { id: string }>(templates: T[]): T[] {
	const seen = new Set<string>();
	for (const t of templates) {
		let id = t.id;
		let n = 1;
		while (seen.has(id)) id = `${t.id}-${n++}`;
		seen.add(id);
		t.id = id;
	}
	return templates;
}
