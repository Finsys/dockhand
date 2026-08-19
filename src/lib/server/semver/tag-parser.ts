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
// Requiring 7+ pure-hex chars keeps real build variants (`-alpine`, `-ls123`,
// `-ubuntu22.04`) intact - they aren't long hex runs - while collapsing the
// per-release hash so every hashed tag of one image shares a flavor and can be
// compared. Guarded by at least one letter so a plain numeric build (`-12345678`)
// isn't mistaken for a hash.
const COMMIT_HASH_RE = /[-.](?=[0-9a-f]*[a-f])[0-9a-f]{7,}$/i;

export function isPrerelease(tag: ParsedTag): boolean {
	return PRERELEASE_RE.test(tag.suffix);
}

/**
 * The "flavor" is the stable part of the suffix — the build variant like
 * `-alpine` or `-ls123` — with any prerelease channel and any trailing commit
 * hash stripped off. So `1.0-alpine` and `1.1-alpine` share the flavor `-alpine`,
 * `1.0-rc1` / `1.0-rc2` share the flavor `` (they only differ in the prerelease),
 * and `2026.8.15-a1b2c3d` / `2026.8.16-b2da6b9` share the flavor `` (they only
 * differ in the per-release hash). This lets one hashed tag suggest the next
 * while still never mixing `-alpine` with bare.
 */
export function flavorOf(tag: ParsedTag): string {
	return tag.suffix
		.replace(COMMIT_HASH_RE, '')
		.replace(PRERELEASE_RE, (_m, delim: string) => (delim === '.' ? '' : delim))
		.replace(/[-.]+$/, ''); // drop the delimiter the prerelease left dangling
}

/** A newer version is only offered within the SAME flavor. Exact match, prerelease-agnostic. */
export function flavorMatches(a: ParsedTag, b: ParsedTag): boolean {
	return flavorOf(a) === flavorOf(b);
}

/** Compare two version tuples pairwise (missing segments count as 0). <0, 0, or >0. */
export function compareParts(a: ParsedTag, b: ParsedTag): number {
	const length = Math.max(a.parts.length, b.parts.length);
	for (let i = 0; i < length; i++) {
		const diff = (a.parts[i] ?? 0) - (b.parts[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

// The `dockhand.version.pattern` label value must start with this scheme, leaving
// room for future non-regex strategies (e.g. `calver:`) under the same label.
const VERSION_PATTERN_SCHEME = 'regex:';
const MAX_PATTERN_LENGTH = 300;
// Nested quantifiers (`(a+)+`, `(a*)*`, `(a+)*`) are the classic catastrophic-
// backtracking shape. Refuse them rather than run an attacker-supplied ReDoS on
// every tag. A conservative reject: a group closed with a quantifier immediately
// followed by another quantifier.
const NESTED_QUANTIFIER_RE = /[+*}]\s*\)[+*?]|\([^)]*[+*][^)]*\)[+*]/;

/**
 * Compile a `dockhand.version.pattern` label value into a RegExp for parseTag's
 * override, or null when absent/invalid. Never throws - a bad pattern degrades to
 * the default parser (null), so a typo can't break the update check. Requires the
 * `regex:` scheme, a `major` named group, a sane length, and rejects obvious
 * catastrophic-backtracking shapes (the value comes from an untrusted image label).
 */
export function compileVersionPattern(value: string | undefined | null): RegExp | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed.startsWith(VERSION_PATTERN_SCHEME)) return null;

	const source = trimmed.slice(VERSION_PATTERN_SCHEME.length);
	if (source.length === 0 || source.length > MAX_PATTERN_LENGTH) return null;
	if (!source.includes('(?<major>')) return null; // must yield at least a major
	if (NESTED_QUANTIFIER_RE.test(source)) return null; // ReDoS guard

	try {
		return new RegExp(source);
	} catch {
		return null; // invalid regex -> fall back to the default parser
	}
}
