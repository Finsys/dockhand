/**
 * Given the tag a container currently runs and every tag the registry offers,
 * decide whether a newer VERSION tag exists — and which versions were skipped
 * along the way. Pure: no network, no registry knowledge, fully unit-testable.
 *
 * This is advisory only. We never auto-apply it: the tag lives in the user's
 * compose, which we don't own. We just tell them "a newer version is out".
 */

import {
	parseTag,
	prefixMatches,
	flavorMatches,
	compareParts,
	isPrerelease,
	type ParsedTag
} from './tag-parser';

export type VersionBump = 'major' | 'minor' | 'patch';

export interface FindNewerOptions {
	/** Cap the offered bump: `patch` stays quiet, `major` offers everything. Default `major`. */
	maxBump?: VersionBump;
	/** Consider `-rc`/`-beta`/... tags even when the current tag is stable. Default false. */
	includePrerelease?: boolean;
	/** Require the same flavor/suffix (`-alpine`). Default true — the #1 noise-killer. */
	matchFlavor?: boolean;
	/**
	 * A compiled `dockhand.version.pattern` override (from compileVersionPattern).
	 * When set, both the current tag and every candidate are parsed with it, so an
	 * image with a non-standard tag scheme can still be compared. Absent = default.
	 */
	versionPattern?: RegExp | null;
}

export interface NewerVersion {
	/** The recommended tag to move to, e.g. `16.4-alpine`. */
	tag: string;
	/** How big the jump is, relative to the current version. */
	bump: VersionBump;
	/** Every newer version between current and target (exclusive of current, inclusive of target), ordered. */
	skipped: string[];
	/** The target tag's manifest digest (`sha256:...`), when probed. Lets the UI show/copy the new tag digest-pinned. */
	digest?: string;
}

/** Which segment first differs decides the bump: [0]=major, [1]=minor, else patch. */
export function classifyBump(current: ParsedTag, candidate: ParsedTag): VersionBump {
	if ((candidate.parts[0] ?? 0) !== (current.parts[0] ?? 0)) return 'major';
	if ((candidate.parts[1] ?? 0) !== (current.parts[1] ?? 0)) return 'minor';
	return 'patch';
}

const BUMP_RANK: Record<VersionBump, number> = { patch: 1, minor: 2, major: 3 };

/** Canonical key for a numeric version: trailing zero segments trimmed, so `1.2`
 *  and `1.2.0` (equal under compareParts) map to the same key. Keeps at least one
 *  segment (`0.0.0` -> `0`). */
function versionKey(parts: number[]): string {
	let end = parts.length;
	while (end > 1 && parts[end - 1] === 0) end--;
	return parts.slice(0, end).join('.');
}

/**
 * Find the newest version tag strictly greater than `currentTag`, or null.
 *
 * Returns null when the current tag isn't a version at all (`latest`, `stable`,
 * a sha) — there is nothing to compare, so no suggestion is ever made.
 */
export function findNewerVersionTag(
	currentTag: string,
	allTags: string[],
	options: FindNewerOptions = {}
): NewerVersion | null {
	const { maxBump = 'major', includePrerelease = false, matchFlavor = true, versionPattern = null } = options;

	const current = parseTag(currentTag, versionPattern);
	if (!current) return null; // floating tag — not a version, never suggest.

	const maxRank = BUMP_RANK[maxBump];
	const currentIsPrerelease = isPrerelease(current);

	const candidates = allTags
		.map((tag) => ({ tag, parsed: parseTag(tag, versionPattern) }))
		.filter((c): c is { tag: string; parsed: ParsedTag } => c.parsed !== null)
		.filter((c) => prefixMatches(c.parsed.prefix, current.prefix))
		.filter((c) => !matchFlavor || flavorMatches(c.parsed, current))
		.filter((c) => includePrerelease || currentIsPrerelease || !isPrerelease(c.parsed))
		.filter((c) => compareParts(c.parsed, current) > 0)
		.filter((c) => BUMP_RANK[classifyBump(current, c.parsed)] <= maxRank);

	if (candidates.length === 0) return null;

	// A registry commonly publishes the same version both with and without the
	// `v` prefix (`v3.6` and `3.6`). They are the SAME version, so collapse them
	// to one entry, keeping the variant whose prefix matches the running tag (so
	// `v3.0` suggests `v3.6`, not `3.6`). Keyed by the numeric tuple.
	const byVersion = new Map<string, { tag: string; parsed: ParsedTag }>();
	for (const c of candidates) {
		// Key on the numeric value with trailing zero segments trimmed, so `1.2` and
		// `1.2.0` (equal under compareParts) collapse to one entry instead of both
		// landing in `skipped` and racing for `target`.
		const key = versionKey(c.parsed.parts);
		const existing = byVersion.get(key);
		if (!existing) {
			byVersion.set(key, c);
			continue;
		}
		// Prefer the variant that shares the current tag's exact prefix.
		const cMatches = c.parsed.prefix === current.prefix;
		const existingMatches = existing.parsed.prefix === current.prefix;
		if (cMatches && !existingMatches) byVersion.set(key, c);
	}

	const deduped = Array.from(byVersion.values());
	// Highest version wins; sort ascending so `skipped` reads oldest -> newest.
	deduped.sort((a, b) => compareParts(a.parsed, b.parsed));
	const target = deduped[deduped.length - 1];

	return {
		tag: target.tag,
		bump: classifyBump(current, target.parsed),
		skipped: deduped.map((c) => c.tag)
	};
}

/**
 * Like findNewerVersionTag, but verifies the chosen target is a real container
 * image before offering it - dropping any tag that turns out to be a Helm chart or
 * other non-image OCI artifact published into the same repo, and re-picking the
 * next-highest version. `probe` returns `{ ok, digest }` where ok=true means a
 * runnable image; the digest (when present) is attached to the result so the UI can
 * offer the new tag digest-pinned. Async + injected so this stays pure/testable.
 *
 * Only the chosen candidate is probed, not every tag. `maxSkips` bounds the extra
 * probes so a repo full of artifacts can't fan out unbounded. `probe` failures
 * should resolve to `{ ok: true }` (fail-open) at the call site so a probe error
 * never hides a real update.
 */
export async function findNewerImageTag(
	currentTag: string,
	allTags: string[],
	probe: (tag: string) => Promise<{ ok: boolean; digest?: string | null }>,
	options: FindNewerOptions = {},
	maxSkips = 5
): Promise<NewerVersion | null> {
	const excluded = new Set<string>();
	for (let i = 0; i <= maxSkips; i++) {
		const pool = excluded.size ? allTags.filter((t) => !excluded.has(t)) : allTags;
		const newer = findNewerVersionTag(currentTag, pool, options);
		if (!newer) return null;
		const { ok, digest } = await probe(newer.tag);
		if (ok) return digest ? { ...newer, digest } : newer;
		excluded.add(newer.tag);
	}
	return null;
}
