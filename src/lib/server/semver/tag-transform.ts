/**
 * Per-container tag transform.
 *
 * A `wud.tag.transform` / `dockhand.tag.transform` label rewrites a tag with a
 * `<regex> => <replacement>` formula (`$1`, `$2`, ... backreferences) BEFORE it is
 * parsed as a version, so an image with a non-standard revision scheme can still be
 * compared. A migrating install keeps producing the same candidates without
 * re-labelling. The label accepts the wud.tag.transform spellings too. Example:
 *   `^(\d+\.\d+\.\d+)-r(\d+).*$ => $1-$2`   turns `2.2.0-r2-ls366` into `2.2.0-2`.
 *
 * Pure: no I/O. The transform is applied to the running tag and to every candidate.
 */

import { firstLabelValue } from '../container-labels';
import {
	ALTERNATION_QUANTIFIER_RE,
	hasTooManyQuantifiers,
	MAX_PATTERN_LENGTH,
	NESTED_QUANTIFIER_RE
} from './tag-parser';

/** Label keys, native first - the order they are consulted in. */
export const TAG_TRANSFORM_LABELS = [
	'dockhand.tag.transform',
	'wud.tag.transform',
	'wud/tag.transform',
	'getwud.app/tag.transform',
	'wud.getwud.io/tag.transform'
] as const;

/** A compiled transform: match this, replace with this (`$n` backrefs resolved). */
export interface TagTransform {
	regex: RegExp;
	replacement: string;
}

/**
 * Compile a `<regex> => <replacement>` formula, or null when it is absent or unsafe.
 * The regex half runs against an attacker-influenceable tag list, so it carries the
 * same ReDoS/length guards as the tag filters; a bad formula degrades to null (no
 * transform) rather than breaking the update check.
 */
export function compileTagTransform(formula: string | undefined | null): TagTransform | null {
	if (!formula || typeof formula !== 'string' || !formula.trim()) return null;
	const arrow = formula.indexOf('=>');
	if (arrow === -1) return null;
	const pattern = formula.slice(0, arrow).trim();
	const replacement = formula.slice(arrow + 2).trim();
	if (!pattern || !replacement) return null;
	if (pattern.length > MAX_PATTERN_LENGTH) return null;
	if (NESTED_QUANTIFIER_RE.test(pattern)) return null;
	if (ALTERNATION_QUANTIFIER_RE.test(pattern)) return null;
	if (hasTooManyQuantifiers(pattern)) return null;
	try {
		return { regex: new RegExp(pattern), replacement };
	} catch {
		return null;
	}
}

/** The compiled transform from a container's labels, or null when none is set/usable. */
export function tagTransformFromLabels(
	labels: Record<string, string> | undefined | null
): TagTransform | null {
	return compileTagTransform(firstLabelValue(labels, TAG_TRANSFORM_LABELS));
}

/**
 * Apply a compiled transform to a tag. A tag the regex does not match is returned
 * UNCHANGED (so a formula scoped to one scheme leaves other tags alone). An optional
 * capture group that did not participate substitutes empty, never the literal
 * "undefined".
 */
export function applyTagTransform(transform: TagTransform | null, tag: string): string {
	if (!transform) return tag;
	const match = tag.match(transform.regex);
	if (!match) return tag;
	return transform.replacement.replace(/\$(\d+)/g, (_whole, n: string) => match[Number(n)] ?? '');
}
