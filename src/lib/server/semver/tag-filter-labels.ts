/**
 * Per-container tag filters for the newer-version check.
 *
 * A repository can carry tags that pass every global filter and still make no sense
 * as an upgrade: a legacy name that sorts high, or a date-style build tag beside a
 * semver one. The global settings cannot express a per-image exception, so a
 * container can name one itself.
 *
 * Native `dockhand.tag.include` / `dockhand.tag.exclude` come first; the `wud.*`
 * equivalents are read so a What's Up Docker install migrates without re-labelling
 * every container. Both are regular expressions, UNANCHORED, matching WUD's own
 * `new RegExp(pattern).test(tag)` - someone bringing a working `wud.tag.include`
 * across must get the same candidates out of it.
 *
 * Filters only ever NARROW the candidate set the global settings produced. A label
 * cannot widen what an instance decided to offer.
 *
 * Pure: no labels knowledge beyond the map it is handed, no registry, no database.
 */

import {
	ALTERNATION_QUANTIFIER_RE,
	hasTooManyQuantifiers,
	MAX_PATTERN_LENGTH,
	NESTED_QUANTIFIER_RE
} from './tag-parser';
import { firstLabelValue } from '../container-labels';

/** Label keys, native first - the order they are consulted in. */
export const TAG_FILTER_LABELS = {
	INCLUDE: [
		'dockhand.tag.include',
		'wud.tag.include',
		'wud/tag.include',
		'getwud.app/tag.include',
		'wud.getwud.io/tag.include'
	],
	EXCLUDE: [
		'dockhand.tag.exclude',
		'wud.tag.exclude',
		'wud/tag.exclude',
		'getwud.app/tag.exclude',
		'wud.getwud.io/tag.exclude'
	]
} as const;

export interface TagFilter {
	/** Only tags matching this are considered. */
	include?: RegExp;
	/** Tags matching this are dropped. */
	exclude?: RegExp;
}

/**
 * WUD interpolates `${major}` and friends into a filter before compiling it. We do
 * not, so a pattern carrying one would compile to a regex matching nothing and
 * silently offer zero candidates. Refusing it degrades to no filter instead.
 */
const PLACEHOLDER = /\$\{/;

/**
 * Compile one pattern, or undefined when it is absent, too long, able to backtrack
 * badly, carries an unsupported placeholder, or will not parse.
 *
 * The length and backtracking guards are the ones `dockhand.version.pattern`
 * already uses - the same class of label, run over the same tag lists, so the two
 * share one definition rather than drifting apart.
 *
 * A rejected regex is IGNORED rather than fatal: a typo in a label must cost the
 * filter, never the update check for that container. It is also never treated as
 * "match nothing", which would silently hide every real update.
 */
function compile(pattern: string | undefined): RegExp | undefined {
	if (!pattern || pattern.length > MAX_PATTERN_LENGTH) return undefined;
	if (PLACEHOLDER.test(pattern)) return undefined;
	if (NESTED_QUANTIFIER_RE.test(pattern) || ALTERNATION_QUANTIFIER_RE.test(pattern)) return undefined;
	if (hasTooManyQuantifiers(pattern)) return undefined;
	try {
		return new RegExp(pattern);
	} catch {
		return undefined;
	}
}

/** Read a container's tag filters from its labels. */
export function tagFilterFromLabels(
	labels: Record<string, string> | undefined | null
): TagFilter {
	return {
		include: compile(firstLabelValue(labels, TAG_FILTER_LABELS.INCLUDE)),
		exclude: compile(firstLabelValue(labels, TAG_FILTER_LABELS.EXCLUDE))
	};
}

/** Whether a filter would change anything, so callers can skip the work. */
export function hasTagFilter(filter: TagFilter): boolean {
	return !!filter.include || !!filter.exclude;
}

/**
 * Apply the filters to a tag list. `include` keeps only what matches; `exclude`
 * drops what matches, and wins over `include` when both name the same tag - the more
 * specific instruction is the one that removes something.
 *
 * The running tag needs no exemption: the version comparison is handed it separately
 * and only ever looks for tags strictly newer, so whether it survives the filter
 * cannot change the answer.
 */
export function applyTagFilter(tags: readonly string[], filter: TagFilter): string[] {
	if (!hasTagFilter(filter)) return [...tags];
	return tags.filter((tag) => {
		if (filter.include && !filter.include.test(tag)) return false;
		if (filter.exclude && filter.exclude.test(tag)) return false;
		return true;
	});
}
