/**
 * Parse a Docker image tag into its numeric version and the text around it, so
 * two tags of the SAME image can be compared as versions.
 *
 * A tag is `<prefix><version><suffix>` where version is the first dotted-number
 * run: `v1.25-alpine` -> prefix `v`, version `1.25`, suffix `-alpine`. The
 * version becomes a plain numeric tuple (`[1, 25]`), which compares CalVer
 * (`2024.1.3`) and SemVer (`1.2.3`) alike with no semver library and no special
 * cases. Pure functions, no I/O.
 */

/** The first dotted-number run in a tag: 2 to 4 numeric segments. */
const VERSION_RE = /\d+\.\d+(?:\.\d+)?(?:\.\d+)?/;

export interface ParsedTag {
	/** The matched version text, e.g. `1.25` or `2024.1.3`. */
	version: string;
	/** Text before the version, e.g. `v` in `v1.25`. */
	prefix: string;
	/** Text after the version, e.g. `-alpine` in `1.25-alpine`. This is the "flavor". */
	suffix: string;
	/** The version as a numeric tuple, e.g. `[1, 25]`. */
	parts: number[];
}

/**
 * Parse a tag into its version parts, or null when it has no version (`latest`,
 * `stable`, a sha). An optional `override` regex (from a `dockhand.version.pattern`
 * label) replaces the default detection for images whose tags don't match the
 * generic dotted-number shape (e.g. a CalVer-plus-hash like `2024.12.5-a1b2c3d`).
 * The override must capture numeric named groups `major`/`minor`/`patch` (patch
 * optional, plus any further `p4`/`p5`); those become `parts`. A tag the override
 * doesn't match is treated as a non-version (null) - same as a floating tag.
 */
export function parseTag(tag: string, override?: RegExp | null): ParsedTag | null {
	if (override) return parseWithOverride(tag, override);

	const match = VERSION_RE.exec(tag);
	if (!match) return null;

	const version = match[0];
	return {
		version,
		prefix: tag.slice(0, match.index),
		suffix: tag.slice(match.index + version.length),
		parts: version.split('.').map(Number)
	};
}

// Numeric named groups the override may capture, in version order. Only `major`
// is required; the rest fill in as present.
const OVERRIDE_PART_GROUPS = ['major', 'minor', 'patch', 'p4', 'p5'] as const;

function parseWithOverride(tag: string, override: RegExp): ParsedTag | null {
	const match = override.exec(tag);
	if (!match || !match.groups) return null;

	const parts: number[] = [];
	for (const name of OVERRIDE_PART_GROUPS) {
		const raw = match.groups[name];
		if (raw === undefined) break; // stop at the first absent segment
		const n = Number(raw);
		if (!Number.isFinite(n)) return null; // a captured non-number is not a version
		parts.push(n);
	}
	if (parts.length === 0) return null; // no `major` captured -> not a version

	// The whole match is the "version"; prefix/suffix are the text around it so
	// flavor matching (e.g. `-alpine`) keeps working under an override too.
	const version = match[0];
	const index = match.index;
	return {
		version,
		prefix: tag.slice(0, index),
		suffix: tag.slice(index + version.length),
		parts
	};
}

/**
 * Two prefixes are equivalent, treating `""` and `"v"` as the same — projects
 * routinely add or drop the leading `v` between releases (`1.2.3` vs `v1.2.3`).
 */
export function prefixMatches(a: string, b: string): boolean {
	const normalize = (p: string) => (p === 'v' ? '' : p);
	return normalize(a) === normalize(b);
}

// A channel marker delimited by start/`-`/`.`, optionally followed by a number
// (`rc1`, `beta.2`) or another delimiter. `\b` won't do: `rc1` has no boundary
// between `c` and `1`.
const PRERELEASE_RE = /(^|[-.])(rc|beta|alpha|nightly|dev|pre|snapshot)(\d|[-.]|$)/i;

// A trailing commit hash, e.g. `-b2da6b90f` in searxng's `2026.8.16-b2da6b90f`.
// Requiring 7+ pure-hex chars keeps real build variants (`-alpine`,
// `-ubuntu22.04`) intact - they aren't long hex runs - while collapsing the
// per-release hash so every hashed tag of one image shares a flavor and can be
// compared. Guarded by at least one letter so a plain numeric build (`-12345678`)
// isn't mistaken for a hash.
const COMMIT_HASH_RE = /[-.](?=[0-9a-f]*[a-f])[0-9a-f]{7,}$/i;

// linuxserver.io appends a build counter (`-ls121`) that increments on every rebuild
// of the same upstream version, so it moves with each release rather than naming a
// variant. Left intact it makes every release its own flavor, and an image pinned as
// `<version>-ls<build>` can never match a candidate. Collapse the digits so
// `2.5.1-ls121` and `2.5.2-ls122` share `-ls`, while `-ls` still never matches bare
// or `-alpine`. The digits stay in `suffix`, so they remain available as a
// tie-breaker between two tags of one upstream version.
const LS_BUILD_RE = /(-ls)\d+$/i;

export function isPrerelease(tag: ParsedTag): boolean {
	return PRERELEASE_RE.test(tag.suffix);
}

/**
 * The "flavor" is the stable part of the suffix — the build variant like
 * `-alpine` — with any prerelease channel, trailing commit hash and linuxserver
 * build counter normalised away. So `1.0-alpine` and `1.1-alpine` share `-alpine`,
 * `2.5.1-ls121` and `2.5.2-ls122` share `-ls`,
 * `1.0-rc1` / `1.0-rc2` share the flavor `` (they only differ in the prerelease),
 * and `2026.8.15-a1b2c3d` / `2026.8.16-b2da6b9` share the flavor `` (they only
 * differ in the per-release hash). This lets one hashed tag suggest the next
 * while still never mixing `-alpine` with bare.
 */
// A build-counter identifier that increments on every rebuild of one upstream version
// (`r2`, `ls121`): a KNOWN short prefix plus digits. Only these collapse to their prefix
// in the flavor; a word carrying a version number (`php8.1`, `node18`, `cuda11.8`) is a
// distinct VARIANT and keeps its digits, so one is never offered as an update to another.
const BUILD_COUNTER_RE = /^(?:ls|r)\d+$/i;

export function flavorOf(tag: ParsedTag): string {
	const stable = tag.suffix
		.replace(COMMIT_HASH_RE, '')
		.replace(LS_BUILD_RE, '$1')
		.replace(PRERELEASE_RE, (_m, delim: string) => (delim === '.' ? '' : delim))
		.replace(/[-.]+$/, ''); // drop the delimiter the prerelease left dangling
	// Split on `-` only, so a dotted variant version (`php8.1`) stays one identifier.
	// A pure-numeric revision (`-1.1`) drops out, a build counter collapses to its
	// prefix (`r2` -> `r`), and a variant token is kept whole. The dropped/collapsed
	// digits stay in `suffix` for compareParts to order on.
	return stable
		.split('-')
		.filter(Boolean)
		.map((id) => {
			if (/^\d+(?:\.\d+)*$/.test(id)) return ''; // numeric revision
			if (BUILD_COUNTER_RE.test(id)) return id.replace(/\d+$/, ''); // build counter
			return id; // variant (kept whole, digits and all)
		})
		.filter(Boolean)
		.join('-');
}

/** A newer version is only offered within the SAME flavor. Exact match, prerelease-agnostic. */
export function flavorMatches(a: ParsedTag, b: ParsedTag): boolean {
	return flavorOf(a) === flavorOf(b);
}

/**
 * Whether `candidate` is a CalVer tag that must NOT be offered as an update to a
 * SemVer `current`. A repo that publishes both `3.1.0` and a
 * date-based `2025.1.1` sorts the CalVer one higher numerically, but it is a
 * different versioning scheme, not a newer release. A SemVer current (major < 100)
 * never upgrades to a 4-digit-year CalVer (major >= 2000) or an Ubuntu-style
 * `YY.0M` CalVer (e.g. `20.04`). The reverse (CalVer current) is unaffected.
 */
const UBUNTU_CALVER_RE = /^\d{2}\.0\d(?:\.|$)/;
export function isCalVerDrift(current: ParsedTag, candidate: ParsedTag): boolean {
	const curMajor = current.parts[0] ?? 0;
	if (curMajor >= 100) return false; // current is itself CalVer-ish
	if ((candidate.parts[0] ?? 0) >= 2000) return true;
	return UBUNTU_CALVER_RE.test(candidate.version);
}

/**
 * Order two suffixes of the SAME upstream version as build/revision strings.
 * Numeric-aware string comparison, so a number anywhere in the suffix orders
 * numerically, not lexically: `-ls10` > `-ls9`, `-1.10` > `-1.9`, `-r3-ls370` >
 * `-r2-ls366`. A numeric-aware string comparison (`localeCompare(..., {numeric:true})`).
 * Only reached for two tags that already share a flavor, so
 * it never has to rank a build suffix against a bare tag.
 */
export function compareSuffix(a: string, b: string): number {
	return Math.sign(a.localeCompare(b, undefined, { numeric: true, sensitivity: 'variant' }));
}

/**
 * Compare two version tuples pairwise (missing segments count as 0). When the
 * numeric versions tie, the build/revision suffix breaks the tie, so
 * `4.2.8-1.1` < `4.2.8-1.2` and `2.5.1-ls121` < `2.5.1-ls122`. <0, 0, or >0.
 *
 * The suffix also orders a prerelease counter (`1.0-rc1` < `1.0-rc2`); whether such a
 * candidate is offered at all is the separate `includePrerelease` policy, decided in
 * the find-newer filter, not here.
 */
export function compareParts(a: ParsedTag, b: ParsedTag): number {
	const length = Math.max(a.parts.length, b.parts.length);
	for (let i = 0; i < length; i++) {
		const diff = (a.parts[i] ?? 0) - (b.parts[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return compareSuffix(a.suffix, b.suffix);
}

// The `dockhand.version.pattern` label value must start with this scheme, leaving
// room for future non-regex strategies (e.g. `calver:`) under the same label.
const VERSION_PATTERN_SCHEME = 'regex:';
/** Shared with the tag filters: a pattern describing a tag name is short. */
export const MAX_PATTERN_LENGTH = 300;
// Nested quantifiers (`(a+)+`, `(a*)*`, `(a+)*`) are the classic catastrophic-
// backtracking shape. Refuse them rather than run an attacker-supplied ReDoS on
// every tag. A conservative reject: a group closed with a quantifier immediately
// followed by another quantifier.
//
// The outer quantifier includes the brace form: `(a+){1,}` backtracks exactly like
// `(a+)+` and measured 24 seconds against a 28-character non-matching tag.
const OUTER_QUANTIFIER = String.raw`(?:[+*?]|\{\d*,\d*\})`;
export const NESTED_QUANTIFIER_RE = new RegExp(
	String.raw`[+*}]\s*\)\s*${OUTER_QUANTIFIER}|\([^)]*[+*][^)]*\)\s*${OUTER_QUANTIFIER}`
);

/**
 * An alternation of overlapping branches under a quantifier, `(a|a)+$`, backtracks
 * just as badly as a nested quantifier but does not match the shape above.
 * Measured: 17 seconds for the `+` form, 40 for `{1,}`, against a non-matching tag.
 */
export const ALTERNATION_QUANTIFIER_RE = new RegExp(
	String.raw`\([^)|]*\|[^)]*\)\s*${OUTER_QUANTIFIER}`
);

/**
 * A long chain of adjacent quantifiers needs no groups at all to blow up:
 * `a{1,9}` repeated ten times is 61 characters with not one parenthesis, and both
 * checks above let it through because they look for a SHAPE. Counting quantifiers
 * bounds the work however the pattern is written.
 *
 * Measured on a chain of bounded repetitions against a non-matching tag: seven
 * costs at most 125ms, eight 604ms, ten runs into seconds and keeps climbing with
 * the tag's length. Eight is the limit, which admits every documented pattern -
 * the most quantifier-heavy is a three-group CalVer override, at seven, and it
 * costs nothing because it is not built to backtrack.
 */
export const MAX_QUANTIFIERS = 8;
const QUANTIFIER_RE = /[+*?]|\{\d*,?\d*\}/g;
/**
 * Group-opening syntax, which spends a `?` without being a quantifier:
 * `(?<name>`, `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`. A named group is REQUIRED to
 * write an override at all, so counting its `?` makes each version part cost two
 * and puts the documented five-part forms over the limit.
 */
const GROUP_SYNTAX_RE = /\(\?(?:<[A-Za-z_][A-Za-z0-9_]*>|<[=!]|[:=!])/g;

/** Whether a pattern carries so many quantifiers that one match could stall. */
export function hasTooManyQuantifiers(source: string): boolean {
	const quantifiersOnly = source.replace(GROUP_SYNTAX_RE, '(');
	return (quantifiersOnly.match(QUANTIFIER_RE) ?? []).length > MAX_QUANTIFIERS;
}

/**
 * Compile a `dockhand.version.pattern` label value into a RegExp for parseTag's
 * override, or null when absent/invalid. Never throws - a bad pattern degrades to
 * the default parser (null), so a typo can't break the update check. Requires the
 * `regex:` scheme, a `major` named group, a sane length, and rejects obvious
 * catastrophic-backtracking shapes (the value comes from an untrusted image label).
 */
/**
 * Why a `dockhand.version.pattern` label was not used, or null when it was. The
 * fallback to the default parser is deliberate - a bad label must cost the label,
 * never the update check - but from outside the label just does nothing, so the
 * caller can log this once instead of leaving somebody to read this file.
 */
export function versionPatternRejection(value: string | undefined | null): string | null {
	if (!value) return null; // no label is not a rejection
	const trimmed = value.trim();
	if (!trimmed.startsWith(VERSION_PATTERN_SCHEME)) return `missing the "${VERSION_PATTERN_SCHEME}" prefix`;

	const source = trimmed.slice(VERSION_PATTERN_SCHEME.length);
	if (source.length === 0) return 'the pattern is empty';
	if (source.length > MAX_PATTERN_LENGTH) return `too long (${source.length} > ${MAX_PATTERN_LENGTH} characters)`;
	if (!source.includes('(?<major>')) return 'no (?<major>) group, so it yields no version';
	if (NESTED_QUANTIFIER_RE.test(source)) return 'a quantified group inside a quantifier can backtrack catastrophically';
	if (ALTERNATION_QUANTIFIER_RE.test(source)) return 'a quantified alternation can backtrack catastrophically';
	if (hasTooManyQuantifiers(source)) return `too many quantifiers (more than ${MAX_QUANTIFIERS})`;
	try {
		new RegExp(source);
	} catch (e) {
		return `it does not compile: ${e instanceof Error ? e.message : String(e)}`;
	}
	return null;
}

export function compileVersionPattern(value: string | undefined | null): RegExp | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed.startsWith(VERSION_PATTERN_SCHEME)) return null;

	const source = trimmed.slice(VERSION_PATTERN_SCHEME.length);
	if (source.length === 0 || source.length > MAX_PATTERN_LENGTH) return null;
	if (!source.includes('(?<major>')) return null; // must yield at least a major
	// ReDoS guards: two shapes plus a count, because a shape check always misses
	// something the same pattern can be written another way to exploit.
	if (NESTED_QUANTIFIER_RE.test(source) || ALTERNATION_QUANTIFIER_RE.test(source)) return null;
	if (hasTooManyQuantifiers(source)) return null;

	try {
		return new RegExp(source);
	} catch {
		return null; // invalid regex -> fall back to the default parser
	}
}
