// Pure filter + rank for the command palette. Import-light (no Svelte) so it is
// unit-testable. The palette holds hundreds of items (nav, themes, fonts, editor themes,
// environments, containers, stacks); this ranks matches cheaply (substring, no fuzzy lib)
// and keeps results grouped so the list stays readable.

export interface PaletteItem {
	/** Stable key (also the aria row id). */
	id: string;
	/** Group heading, e.g. 'Navigation' | 'Light theme' | 'Containers' | 'Stacks'. */
	group: string;
	/** Display text, matched with highest priority. */
	label: string;
	/** Pre-lowercased extra haystack (keywords + image + envName + aliases). */
	keywords: string;
	/** Drives a current-selection checkmark (theme/font/env). */
	active?: boolean;
}

/** Per-group cap applied when the query is empty, so the default view stays small. */
export type DefaultCaps = Record<string, number>;

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** The word-boundary matcher for a query: `q` starts a word (^, space, -, _, /). */
export function wordBoundaryRegex(q: string): RegExp {
	return new RegExp(String.raw`(^|[\s\-_/])` + escapeRegExp(q));
}

/**
 * Match/rank tier for one item against a query. Lower number = better match; -1 = no
 * match. Ordering: label-prefix < label-word-boundary < label-substring < keyword-substring.
 * `wb` is the pre-compiled word-boundary regex for `q` (compiled ONCE per query by the
 * caller, not per item - a fresh RegExp per item would be a perf killer at hundreds of
 * items). When omitted (test convenience) it is compiled here.
 */
export function rankItem(item: PaletteItem, q: string, wb: RegExp = wordBoundaryRegex(q)): number {
	if (!q) return 0;
	const label = item.label.toLowerCase();
	if (label.startsWith(q)) return 0;
	if (wb.test(label)) return 1;
	if (label.includes(q)) return 2;
	if (item.keywords.includes(q)) return 3;
	return -1;
}

/**
 * Filter + rank the palette. Results stay grouped (a group's items never interleave with
 * another group's), ordered by (group order, match tier, original index) so the sort is
 * stable within a tier. An empty/whitespace query returns a CAPPED default set per group
 * (via `defaultCaps`, default cap = Infinity for groups not listed) so the initial view
 * doesn't mount every item.
 */
export function filterPalette(
	items: PaletteItem[],
	rawQuery: string,
	opts: { defaultCaps?: DefaultCaps } = {}
): PaletteItem[] {
	const q = rawQuery.trim().toLowerCase();

	// group order = first appearance in the source list, so groups render in a stable order.
	const groupOrder = new Map<string, number>();
	for (const it of items) if (!groupOrder.has(it.group)) groupOrder.set(it.group, groupOrder.size);

	if (!q) {
		const caps = opts.defaultCaps ?? {};
		const perGroup = new Map<string, number>();
		const out: Array<{ item: PaletteItem; tier: number; i: number; g: number }> = [];
		items.forEach((item, i) => {
			const used = perGroup.get(item.group) ?? 0;
			const cap = caps[item.group] ?? Infinity;
			if (used >= cap) return;
			perGroup.set(item.group, used + 1);
			out.push({ item, tier: 0, i, g: groupOrder.get(item.group)! });
		});
		return sortGrouped(out);
	}

	const wb = wordBoundaryRegex(q); // compile ONCE per query, not per item
	const scored: Array<{ item: PaletteItem; tier: number; i: number; g: number }> = [];
	items.forEach((item, i) => {
		const tier = rankItem(item, q, wb);
		if (tier >= 0) scored.push({ item, tier, i, g: groupOrder.get(item.group)! });
	});
	return sortGrouped(scored);
}

function sortGrouped(
	scored: Array<{ item: PaletteItem; tier: number; i: number; g: number }>
): PaletteItem[] {
	scored.sort((a, b) => a.g - b.g || a.tier - b.tier || a.i - b.i);
	return scored.map((s) => s.item);
}
