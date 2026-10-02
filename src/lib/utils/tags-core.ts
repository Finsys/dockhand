/**
 * Pure helpers for user-defined container/stack tags. Distinct from
 * Docker labels - these are Dockhand's own organizational tags. No I/O so they are
 * unit-testable and shared by the API and the UI.
 */

/** Max length of a single tag. */
export const MAX_TAG_LENGTH = 32;

// A curated, vibrant tag palette: distinct, well-spaced hues (no near-duplicate
// grays or shades). Rendered via inline styles, so it needs no Tailwind class per
// colour. The stored value is the KEY; the UI looks up the hex here.
export const TAG_HEX: Record<string, string> = {
	slate: '#64748b',
	graphite: '#334155',
	ruby: '#e11d48',
	red: '#ef4444',
	coral: '#fb7185',
	orange: '#f97316',
	amber: '#f59e0b',
	gold: '#eab308',
	lime: '#84cc16',
	green: '#22c55e',
	emerald: '#10b981',
	forest: '#15803d',
	teal: '#14b8a6',
	cyan: '#06b6d4',
	sky: '#0ea5e9',
	blue: '#3b82f6',
	indigo: '#6366f1',
	royal: '#4338ca',
	violet: '#8b5cf6',
	purple: '#a855f7',
	grape: '#7e22ce',
	fuchsia: '#d946ef',
	magenta: '#c026d3',
	pink: '#ec4899'
};

/** All palette colour keys, in display order. */
export const TAG_COLORS = Object.keys(TAG_HEX);
export type TagColor = string;
export const DEFAULT_TAG_COLOR: TagColor = 'slate';

/** Coerce an arbitrary colour value to a palette colour, defaulting to slate. */
export function normalizeColor(raw: unknown): TagColor {
	return typeof raw === 'string' && raw in TAG_HEX ? raw : DEFAULT_TAG_COLOR;
}

/** The hex for a colour key (falls back to the default). */
export function tagHex(color: string): string {
	return TAG_HEX[color] ?? TAG_HEX[DEFAULT_TAG_COLOR];
}

/** A tag as stored/returned: catalog id, name, colour, and an optional lucide icon. */
export interface Tag {
	id: number;
	name: string;
	color: TagColor;
	icon?: string | null;
	/** Comes from this item's stack, so it is shown but cannot be removed here. */
	inherited?: boolean;
}

// A tag is a short human label: letters, digits, spaces, and `_ - . /` (so
// "home cloud", "web/proxy", "v2.0" all work). No control chars or other punctuation.
const TAG_CHARS = /^[A-Za-z0-9 _.\-/]+$/;

/**
 * Normalise a single tag: trim and collapse internal whitespace. Returns null if it
 * is empty or otherwise invalid (too long, illegal characters).
 */
export function normalizeTag(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const t = raw.trim().replace(/\s+/g, ' ');
	if (!t) return null;
	if (t.length > MAX_TAG_LENGTH) return null;
	if (!TAG_CHARS.test(t)) return null;
	return t;
}

export type TagFilterMode = 'all' | 'any';

/**
 * True if an item's tags satisfy the filter. `mode` 'all' requires every selected
 * tag id (AND); 'any' requires at least one (OR). An empty filter matches everything;
 * a non-empty filter never matches an untagged item.
 */
export function matchesTagFilter(
	itemTagIds: number[] | undefined,
	filterTagIds: number[],
	mode: TagFilterMode = 'all'
): boolean {
	if (!filterTagIds.length) return true;
	if (!itemTagIds?.length) return false;
	const have = new Set(itemTagIds);
	return mode === 'any'
		? filterTagIds.some((id) => have.has(id))
		: filterTagIds.every((id) => have.has(id));
}

/** Case-insensitive name order, tie-broken by id so it is total and stable. #1625 */
export function compareTagNames(a: Tag, b: Tag): number {
	return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id - b.id;
}

/**
 * Build a DataGrid group descriptor for an item's unique tag COMBINATION (used by
 * the containers/stacks "group by tag" mode). Returns null for an untagged item so
 * it falls into the trailing "Untagged" bucket. The key is the numerically sorted
 * tag ids joined with '+' (stable across renames, so collapsed state survives); the
 * label, colour and icons follow tag-name order.
 *
 * `tagOrder` is the user's arrangement of the catalogue. A group sits where its
 * highest-placed tag sits, so putting `prod` at the top brings every group that
 * carries it forward. Without an arrangement the weight is the tag count, which
 * keeps single-tag groups first and leaves groupData to sort them by label.
 */
export function tagGroupDescriptor(
	tags: Tag[],
	tagOrder: readonly number[] = []
): {
	key: string;
	label: string;
	color: string;
	icons: (string | null)[];
	order: number;
} | null {
	if (!tags.length) return null;
	const byName = tags.slice().sort(compareTagNames);
	return {
		key: tags.map((t) => t.id).sort((a, b) => a - b).join('+'),
		label: byName.map((t) => t.name).join(' + '),
		color: tagHex(byName[0].color),
		icons: byName.map((t) => t.icon ?? null),
		order: groupWeight(tags, tagOrder)
	};
}

/** Room for every tag an item could plausibly carry, between two positions. */
const POSITION_STRIDE = 1000;
/** Rank for a tag the user never arranged: after every one they did. */
const UNARRANGED = 1_000_000;

/**
 * Where a tag combination sits among the groups: the position of its
 * highest-placed tag, then the number of tags it carries. So `prod` leads the
 * groups that merely include prod, and a tag the user never arranged ranks after
 * every one they did. An unarranged catalogue keeps its alphabetical reading.
 */
function groupWeight(tags: Tag[], tagOrder: readonly number[]): number {
	if (!tagOrder.length) return tags.length;
	const best = Math.min(
		...tags.map((t) => {
			const at = tagOrder.indexOf(t.id);
			return at === -1 ? UNARRANGED : at;
		})
	);
	return best * POSITION_STRIDE + Math.min(tags.length, POSITION_STRIDE - 1);
}

/** The label a container uses to name its own tags. */
export const TAGS_LABEL = 'dockhand.tags';

/**
 * A tag as a label spells it: a name, and optionally the colour and icon to show
 * it with. Both extras are suggestions - a name the catalogue already knows is
 * drawn the way the catalogue says.
 */
export interface LabelTagSpec {
	name: string;
	color?: TagColor;
	icon?: string;
}

/**
 * Decides whether an icon name is one the UI can actually draw. Injected because
 * the icon set lives with the lucide components, and this module stays free of
 * them so the server can import it.
 */
export type IconNameCheck = (name: string) => boolean;

/**
 * Read one `name[:color[:icon]]` entry. Colour and icon are optional, and an
 * unusable one is dropped rather than failing the whole entry - a typo costs the
 * colour or the icon, not the tag.
 *
 * A tag name can contain `/` but never `:`, so splitting on `:` is unambiguous.
 * Without an `iconKnown` check the icon is left unvalidated, which renders as the
 * fallback glyph; callers that can draw icons should pass one.
 */
function parseLabelTagSpec(part: string, iconKnown?: IconNameCheck): LabelTagSpec | null {
	const [rawName, rawColor, ...rest] = part.split(':');
	const name = normalizeTag(rawName);
	if (!name) return null;

	const spec: LabelTagSpec = { name };

	const color = rawColor?.trim().toLowerCase();
	const colorIsPalette = !!color && color in TAG_HEX;
	if (colorIsPalette) spec.color = color;

	// Everything after the colour is the icon, rejoined: a second field that is not
	// a colour belongs to the icon, and an EMPTY one is the skipped colour slot of
	// `name::icon`. Rejoining keeps a colon-bearing value intact for the icon check
	// to accept or reject, instead of silently truncating it.
	const iconParts = colorIsPalette || !rawColor?.trim() ? rest : [rawColor, ...rest];
	const icon = iconParts.join(':').trim();
	if (icon && ICON_CHARS.test(icon) && (!iconKnown || iconKnown(icon))) spec.icon = icon;

	return spec;
}

// The shape an icon reference can take at all; whether the name exists is a
// separate question only a caller with the icon set can answer.
const ICON_CHARS = /^[A-Za-z0-9:-]{1,64}$/;

/**
 * The tags a container names in its `dockhand.tags` label, with whatever colour
 * and icon each entry asks for.
 *
 * Read wherever containers are listed, so it covers a container Dockhand never
 * deployed - one started by `docker run` or by compose from a terminal.
 */
export function labelTagSpecs(
	labels: Record<string, string> | undefined | null,
	iconKnown?: IconNameCheck
): LabelTagSpec[] {
	const raw = labels?.[TAGS_LABEL];
	if (typeof raw !== 'string') return [];
	const seen = new Set<string>();
	const specs: LabelTagSpec[] = [];
	for (const part of raw.split(',')) {
		const spec = parseLabelTagSpec(part, iconKnown);
		if (!spec) continue;
		const key = spec.name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		specs.push(spec);
	}
	return specs;
}

/** Just the names, for callers that only group or filter by them. */
export function labelTagNames(labels: Record<string, string> | undefined | null): string[] {
	return labelTagSpecs(labels).map((s) => s.name);
}

/**
 * The tags to show for one container: those assigned in Dockhand, plus the ones
 * its label names.
 *
 * A label name matching a catalogue tag resolves to that tag, so it carries the
 * colour and icon the user chose; a name with no catalogue entry still shows,
 * with the default look and a negative id that cannot collide with a stored one.
 */
export function mergeLabelTags(
	assigned: Tag[],
	labels: Record<string, string> | undefined | null,
	catalog: Tag[],
	iconKnown?: IconNameCheck
): Tag[] {
	return mergeNamedTags(assigned, labelTagSpecs(labels, iconKnown), catalog);
}

/**
 * Merge tag NAMES into a list of assigned tags.
 *
 * A name matching a catalogue tag resolves to it, so it carries the colour and
 * icon the user chose; a name with no entry still shows, with the default look
 * and a negative id that cannot collide with a stored one.
 */
export function mergeNamedTags(
	assigned: Tag[],
	names: readonly (string | LabelTagSpec)[] | undefined | null,
	catalog: Tag[],
	iconKnown?: IconNameCheck
): Tag[] {
	if (!names?.length) return assigned;

	const byName = new Map(catalog.map((t) => [t.name.toLowerCase(), t]));
	const out = [...assigned];
	const have = new Set(assigned.map((t) => t.name.toLowerCase()));

	for (const entry of names) {
		const spec: LabelTagSpec = typeof entry === 'string' ? { name: entry } : entry;
		const key = spec.name.toLowerCase();
		if (have.has(key)) continue;
		have.add(key);
		const known = byName.get(key);
		if (known) {
			// The catalogue is the instance-wide definition of this tag, so it keeps
			// its colour and icon; a label asking for different ones is not honoured.
			out.push(known);
			continue;
		}
		// A spec built server-side has not been checked against the icon set, so
		// drop a name the UI cannot draw rather than show a placeholder glyph.
		const icon = spec.icon && (!iconKnown || iconKnown(spec.icon)) ? spec.icon : null;
		out.push({
			id: labelTagId(spec.name),
			name: spec.name,
			color: spec.color ?? DEFAULT_TAG_COLOR,
			icon
		});
	}
	return out;
}

/**
 * The stand-in id for a tag that exists only in a label.
 *
 * Derived from the name so the same tag carries the same id on every row: the
 * filter holds ids, and a positional id would make selecting one label tag match
 * a different one. Negative to stay clear of the catalogue's own ids.
 */
export function labelTagId(name: string): number {
	const key = name.toLowerCase();
	let hash = 0;
	for (let i = 0; i < key.length; i++) {
		hash = (hash * 31 + key.charCodeAt(i)) | 0;
	}
	return -(Math.abs(hash) % 2_000_000_000) - 1;
}

/**
 * The tag names a stack's containers name between them, first-seen order.
 *
 * A stack has no labels of its own on the daemon - compose stamps only the
 * project name - so a stack is described by what its services ask for.
 */
export function stackLabelTags(
	containerLabels: Array<Record<string, string> | undefined | null>,
	iconKnown?: IconNameCheck
): LabelTagSpec[] {
	const seen = new Set<string>();
	const specs: LabelTagSpec[] = [];
	for (const labels of containerLabels) {
		for (const spec of labelTagSpecs(labels, iconKnown)) {
			const key = spec.name.toLowerCase();
			if (seen.has(key)) continue;
			// Two services can spell the same tag differently; the first one wins, so
			// the stack's colours do not depend on container listing order changing.
			seen.add(key);
			specs.push(spec);
		}
	}
	return specs;
}

/**
 * The tags to show for a container, with the ones its stack carries folded in.
 *
 * Inherited rather than copied: nothing is written, so changing a stack's tags
 * shows up at once, a new container picks them up on its own, and removing one
 * from the stack can never take away a tag assigned to the container directly.
 *
 * A tag already on the container wins, so its own colour and icon are kept and it
 * stays removable; `inherited` marks the rest, which belong to the stack and
 * cannot be taken off the container.
 */
export function withStackTags(ownTags: Tag[], stackTags: Tag[]): Tag[] {
	if (!stackTags.length) return ownTags;
	const have = new Set(ownTags.map((t) => t.name.toLowerCase()));
	const out = [...ownTags];
	for (const tag of stackTags) {
		const key = tag.name.toLowerCase();
		if (have.has(key)) continue;
		have.add(key);
		out.push({ ...tag, inherited: true });
	}
	return out;
}

/**
 * The tags the filter offers: the catalogue, plus any tag only a label names.
 *
 * Without the second half a label tag could be seen on a row but not filtered or
 * grouped by. A name already in the catalogue is not added twice.
 */
export function filterTagList(catalog: Tag[], rowTags: Tag[][]): Tag[] {
	const out = [...catalog];
	const have = new Set(catalog.map((t) => t.name.toLowerCase()));
	for (const tags of rowTags) {
		for (const tag of tags) {
			const key = tag.name.toLowerCase();
			if (have.has(key)) continue;
			have.add(key);
			out.push(tag);
		}
	}
	return out;
}

/**
 * The filter selection to keep, given the tags the picker offers.
 *
 * Drops an id nothing offers any more - a deleted catalogue tag, or a label tag
 * whose last row is gone - so a filter can never empty the list with no visible
 * cause. `ready` is false while the catalogue or the rows are still loading:
 * measuring a selection against a half-built picker would drop every valid id,
 * and the selection is persisted as soon as it changes.
 */
export function prunedTagFilter(saved: number[], offered: Tag[], ready: boolean): number[] {
	if (!ready) return saved;
	const ids = new Set(offered.map((t) => t.id));
	return saved.every((id) => ids.has(id)) ? saved : saved.filter((id) => ids.has(id));
}
