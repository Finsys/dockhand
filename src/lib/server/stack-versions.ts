/**
 * Pure per-stack version store.
 *
 * Owns the per-stack `.history/` directory (`compose.json` + `env.json`), each
 * holding a bounded, secret-free history of versions.
 *
 * ## Purity / test-importability
 * This module is PURE: it imports `node:fs`, `node:path`, and the pure
 * `parseEnvVars` helper from `./env-parser.js` (itself import-free — pure string
 * parsing, no DB). It does NOT import `stacks.ts` or `db.ts` at the top level:
 * `stacks.ts` imports `./db/drizzle.js` whose top-level `seedDatabase()` opens
 * better-sqlite3, which is NOT loadable under bun test. Keeping those imports
 * out means every bun test that touches this module runs without the
 * better-sqlite3 load (a top-level import would crash every such test).
 *
 * ## Secret-free
 * For `env` versions, secret keys are identified BY NAME (the `secretKeys` input,
 * supplied by the caller — S03 feeds it from `getStackInjectedSecretKeys`) — their
 * VALUES live in the DB and are injected at runtime, so they must never be
 * captured in a saved env version. `assertSecretFree` rejects a payload that still
 * carries a secret key (throwing an error naming the first leaked key);
 * `filterSecretVars` returns a new object holding only the non-secret keys. When
 * `type === 'env'` and `secretKeys` is provided, `saveVersion` asserts BEFORE
 * storing so a leaked secret fails the save loudly. The module never queries the DB
 * — it stays pure.
 *
 * ## Sync + caller-supplied dir
 * All functions are SYNC and take a RESOLVED `stackDir: string`
 * (caller-supplied; S03 resolves it via `getStackDir` in the real runtime) and
 * operate on `join(stackDir, HISTORY_DIRNAME)`. This module never calls
 * `getStackDir` / `findStackDir` itself — they are async + DB-coupled.
 *
 * ## Bounding
 * Histories are bounded to `maxVersions` (default `DEFAULT_MAX_VERSIONS`). The
 * safe version (the last-saved / last-deployed version, identified by id OR
 * timestamp) is NEVER dropped, even when it is the oldest. When over the bound,
 * the OLDEST non-safe versions are dropped first.
 *
 * ## Atomicity
 * Writes go through `atomicWriteFile`: write to `<file>.tmp`, then `renameSync`
 * the tmp onto the target (atomic on the same fs). On any failure the tmp is
 * removed and the original error is rethrown — the target is never left with a
 * partial file, and a pre-existing stale tmp is REPLACED (writeFileSync
 * truncates it), never merged or appended to.
 *
 * ## Corruption
 * A missing `.history/` dir or file reads as an empty history. A PRESENT but
 * MALFORMED history file throws — corruption is surfaced, never masked.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseEnvVars } from './env-parser.js';

// Re-export the pure env parser so this module is the single surface for the
// env-versioning primitives (saveVersion, filterSecretVars, assertSecretFree,
// parseEnvVars) that S03 will consume when wiring the save/revert/deploy flow.
// `parseEnvVars` itself is NOT used by the guard functions — the caller parses
// raw .env content into a record, then this module filters/asserts it.
export { parseEnvVars };

/** Per-stack history directory name (relative to the resolved stack dir). */
export const HISTORY_DIRNAME = '.history';

/** Default bound on the number of stored versions per stack/type. */
export const DEFAULT_MAX_VERSIONS = 20;

/** The kind of version stored: a compose YAML string, or a non-secret env record. */
export type VersionType = 'compose' | 'env';

/**
 * A single stored version.
 * - `compose`: `content` is the compose YAML string.
 * - `env`: `content` is a non-secret `Record<string, string>` of env vars.
 */
export interface StackVersion {
	id: string;
	timestamp: string;
	content: string | Record<string, string>;
}

/** Optional inputs to `saveVersion`. All injectable for deterministic tests. */
export interface SaveVersionOptions {
	/** Bound to apply after appending (defaults to DEFAULT_MAX_VERSIONS). */
	maxVersions?: number;
	/** The safe version (id or timestamp) that must never be dropped. */
	safe?: string;
	/** Explicit id (defaults to `timestamp`, deduped to stay unique). */
	id?: string;
	/** Explicit ISO-8601 timestamp (defaults to now). */
	timestamp?: string;
	/**
	 * For `env` versions only: the secret key NAMES that must NOT appear in
	 * `content`. When provided (and `type === 'env'`), `saveVersion` asserts the
	 * payload is secret-free before storing. The module never queries the DB for
	 * these — the caller supplies the real names (S03 via getStackInjectedSecretKeys).
	 */
	secretKeys?: string[];
}

/**
 * Resolve the history file path for a stack dir and version type.
 * `compose` -> `<stackDir>/.history/compose.json`,
 * `env`     -> `<stackDir>/.history/env.json`.
 */
export function historyPath(stackDir: string, type: VersionType): string {
	return join(stackDir, HISTORY_DIRNAME, type === 'compose' ? 'compose.json' : 'env.json');
}

/**
 * Atomically write `data` to `filePath` on the same filesystem.
 *
 * Writes to `filePath + '.tmp'` then `renameSync`s it onto `filePath` (atomic).
 * Ensures the target directory exists first (so the first save creates
 * `.history/`); an already-existing dir is left alone. On ANY failure the tmp
 * is removed (if present) and the original error is rethrown. A pre-existing
 * stale tmp is REPLACED (writeFileSync truncates it), never merged or appended
 * to.
 */
export function atomicWriteFile(filePath: string, data: string): void {
	const tmpPath = filePath + '.tmp';
	try {
		// Ensure the target directory exists (first save creates .history/).
		// Guarded: an existing dir (e.g. already present in a failure test) is
		// left alone so we never call mkdir on a dir we cannot write.
		const dir = dirname(filePath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(tmpPath, data, 'utf8');
		renameSync(tmpPath, filePath);
	} catch (err) {
		// Best-effort cleanup of the tmp on any failure; swallow a cleanup error
		// so the original error (below) is what surfaces.
		try {
			if (existsSync(tmpPath)) unlinkSync(tmpPath);
		} catch {
			// ignore cleanup failure
		}
		throw err;
	}
}

/**
 * Read a history file. Returns `{ versions: [] }` when the `.history/` dir or
 * its file is absent (never an error). Throws when the file is PRESENT but the
 * JSON is malformed or has the wrong shape — corruption is surfaced, never masked.
 */
export function readHistoryFile(stackDir: string, type: VersionType): { versions: StackVersion[] } {
	const file = historyPath(stackDir, type);
	if (!existsSync(file)) return { versions: [] };
	const raw = readFileSync(file, 'utf8');
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`Malformed history file at ${file}: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { versions?: unknown }).versions)) {
		throw new Error(`Malformed history file at ${file}: expected a { versions: [...] } object`);
	}
	return { versions: (parsed as { versions: StackVersion[] }).versions };
}

/**
 * List the last `limit` versions (default DEFAULT_MAX_VERSIONS), NEWEST-FIRST.
 * Each returned version carries its `id` and ISO `timestamp`. A missing dir/file
 * yields `[]`.
 */
export function listVersions(stackDir: string, type: VersionType, limit?: number): StackVersion[] {
	const { versions } = readHistoryFile(stackDir, type);
	const n = limit ?? DEFAULT_MAX_VERSIONS;
	return versions.slice().sort(compareByTimestampDesc).slice(0, n);
}

/**
 * Append a version, bound the history to `maxVersions` (default
 * DEFAULT_MAX_VERSIONS) via `boundVersions`, atomically write the whole file,
 * and return the new `{ id, timestamp }`.
 *
 * `timestamp` defaults to `new Date().toISOString()`; `id` defaults to
 * `timestamp`, deduped by appending `-N` on collision so ids stay unique.
 */
export function saveVersion(
	stackDir: string,
	type: VersionType,
	content: string | Record<string, string>,
	opts: SaveVersionOptions = {}
): { id: string; timestamp: string } {
	// Defense-in-depth on top of the caller's filterSecretVars: for env versions,
	// reject a payload that STILL carries a secret key (by name) before storing.
	if (type === 'env' && opts.secretKeys) {
		assertSecretFree(content as Record<string, string>, opts.secretKeys);
	}
	const { versions } = readHistoryFile(stackDir, type);
	const maxN = opts.maxVersions ?? DEFAULT_MAX_VERSIONS;
	const timestamp = opts.timestamp ?? new Date().toISOString();
	const id = opts.id ?? dedupeId(versions, timestamp);
	// CROSS-LIST DEDUP (the revert case): when the incoming content already has
	// an older version entry (e.g. a save right after reverting to an older
	// version), drop that older duplicate so the history never shows two
	// identical entries - the newest entry stays the single representative. The
	// safe (deployed) version is NEVER dropped by dedup: the deployed anchor
	// takes priority, so a save matching the deployed content simply appends a
	// new entry next to it.
		// COLLAPSE (single representative per distinct content): the history is a
	// DISTINCT-CONTENT timeline - each content appears at most once, the NEWEST
	// entry being the representative. This subsumes the revert case (saving
	// content equal to an older version replaces that older entry) and also
	// normalizes lists that accumulated duplicates (e.g. saved before this
	// invariant existed). The safe (deployed) version is NEVER collapsed: the
	// deployed anchor must stay identifiable even when a newer entry holds the
	// same content.
	// The incoming entry (newest) is folded INTO the collapse so an older entry
	// with identical content (the revert case) is dropped in the same pass.
	const { collapsed } = collapseDuplicateVersions(
		[...versions, { id, timestamp, content }],
		opts.safe
	);
	const next = collapsed;
	const bounded = boundVersions(next, maxN, opts.safe);
	atomicWriteFile(historyPath(stackDir, type), JSON.stringify({ versions: bounded }, null, 2));
	return { id, timestamp };
}

/**
 * Keep at most `maxN` versions, ALWAYS preserving the safe version
 * (`v.id === safe || v.timestamp === safe`). When over the bound, drop the
 * OLDEST non-safe versions first (lowest timestamp first). Shared by
 * `saveVersion` and `prune` so BOTH paths respect the safe version.
 *
 * The safe invariant wins: even if more safe versions exist than `maxN`, they
 * are all preserved (the total may then exceed `maxN`).
 */
/**
 * Collapse a version list so each DISTINCT content appears at most once: the
 * NEWEST entry is the representative, older entries with equal content are
 * dropped. The safe (deployed) version is NEVER dropped, even when a newer
 * entry holds the same content (the deployed anchor must stay identifiable by
 * its own timestamp).
 *
 * Pure: takes and returns plain arrays. Scans newest-first, comparing each
 * version against the versions already KEPT (not the raw list, so a version
 * that is itself dropped does not shield an older duplicate).
 */
export function collapseDuplicateVersions(
	versions: StackVersion[],
	safe?: string
): { collapsed: StackVersion[]; changed: boolean } {
	const newestFirst = versions.slice().sort(compareByTimestampDesc);
	const kept: StackVersion[] = [];
	let changed = false;
	for (const v of newestFirst) {
		const dupOfKeptNewer = kept.some((k) => versionContentEquals(k.content, v.content));
		if (isSafeVersion(v, safe) || !dupOfKeptNewer) {
			kept.push(v);
		} else {
			changed = true;
		}
	}
	// Stored file keeps the historical OLDEST-FIRST ordering.
	return { collapsed: kept.reverse(), changed };
}

/**
 * Normalize an on-disk history file in place: collapse duplicate-content
 * entries (see collapseDuplicateVersions) and rewrite the file ONLY when
 * something actually changed (no mtime churn on already-clean lists). Best-
 * effort callers can ignore the return.
 */
export function collapseHistoryFile(
	stackDir: string,
	type: VersionType,
	safe?: string
): boolean {
	const { versions } = readHistoryFile(stackDir, type);
	const { collapsed, changed } = collapseDuplicateVersions(versions, safe);
	if (changed) {
		atomicWriteFile(historyPath(stackDir, type), JSON.stringify({ versions: collapsed }, null, 2));
	}
	return changed;
}

export function boundVersions(versions: StackVersion[], maxN: number, safe?: string): StackVersion[] {
	if (versions.length <= maxN) return versions;

	const safeVersions = versions.filter((v) => isSafeVersion(v, safe));
	const nonSafeVersions = versions.filter((v) => !isSafeVersion(v, safe));

	// Keep every safe version unconditionally. Fill the remaining capacity with
	// the NEWEST non-safe versions so the OLDEST non-safe are dropped first.
	const maxNonSafe = maxN - safeVersions.length;
	let keptNonSafe: StackVersion[];
	if (maxNonSafe < 0) {
		// More safe versions than the bound allows; the safe invariant wins.
		keptNonSafe = [];
	} else if (maxNonSafe >= nonSafeVersions.length) {
		keptNonSafe = nonSafeVersions;
	} else {
		const oldestFirst = [...nonSafeVersions].sort(compareByTimestampAsc);
		keptNonSafe = oldestFirst.slice(-maxNonSafe);
	}

	return [...safeVersions, ...keptNonSafe];
}

/**
 * Bound an existing history to `maxN`, atomically rewriting ONLY if versions
 * were actually removed. Returns `{ pruned }` (the number removed; 0 = no-op).
 * A missing dir/file is a no-op.
 */
export function prune(stackDir: string, type: VersionType, maxN: number, safe?: string): { pruned: number } {
	const { versions } = readHistoryFile(stackDir, type);
	if (versions.length === 0) return { pruned: 0 };
	const bounded = boundVersions(versions, maxN, safe);
	const pruned = versions.length - bounded.length;
	if (pruned <= 0) return { pruned: 0 };
	atomicWriteFile(historyPath(stackDir, type), JSON.stringify({ versions: bounded }, null, 2));
	return { pruned };
}

/**
 * Ascending by ISO timestamp (newest last). Ties (identical timestamp) fall back
 * to id so the order is deterministic.
 */
function compareByTimestampAsc(a: StackVersion, b: StackVersion): number {
	if (a.timestamp < b.timestamp) return -1;
	if (a.timestamp > b.timestamp) return 1;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Descending by ISO timestamp (newest first). Ties fall back to id (descending)
 * so the order is deterministic.
 */
	/**
	 * Whether a version is the protected "safe" (deployed) version for a given
	 * safe value (matched by id OR timestamp). `safe == null` -> never safe.
	 * Shared by `boundVersions` and the cross-list dedup in `saveVersion`.
	 */
	export function isSafeVersion(v: StackVersion, safe?: string): boolean {
		return safe != null && (v.id === safe || v.timestamp === safe);
	}

	/**
	 * Deep equality for version content: strict equality for strings (compose)
	 * and key/value equality for env Records. Exported so callers (e.g.
	 * stack-version-wiring) can compare against stored versions.
	 */
	export function versionContentEquals(
		stored: string | Record<string, string> | undefined,
		coming: string | Record<string, string>
	): boolean {
		if (stored === undefined) return false;
		if (typeof stored === 'string' || typeof coming === 'string') return stored === coming;
		const a = stored as Record<string, string>;
		const b = coming as Record<string, string>;
		const aKeys = Object.keys(a);
		if (aKeys.length !== Object.keys(b).length) return false;
		return aKeys.every((k) => a[k] === b[k]);
	}

function compareByTimestampDesc(a: StackVersion, b: StackVersion): number {
	if (a.timestamp < b.timestamp) return 1;
	if (a.timestamp > b.timestamp) return -1;
	return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Pick a unique id: `base` if unused, else `base-1`, `base-2`, ... until unique.
 * Keeps ids unique so the default `id = timestamp` never collides across two
 * saves that share a timestamp.
 */
function dedupeId(existing: StackVersion[], base: string): string {
	const existingIds = new Set(existing.map((v) => v.id));
	if (!existingIds.has(base)) return base;
	let n = 1;
	while (existingIds.has(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}

/**
 * Assert that `vars` carries NO secret key (a key present in `secretKeys`).
 * Secret keys are identified BY NAME — their values live in the DB and are
 * injected at runtime, so a secret key must never be captured in a saved env
 * version. Throws an error naming the FIRST leaked key (object key order) when
 * any key in `vars` is present in `secretKeys`; a clean payload does not throw.
 */
export function assertSecretFree(vars: Record<string, string>, secretKeys: string[]): void {
	if (secretKeys.length === 0) return;
	const secretSet = new Set(secretKeys);
	for (const key of Object.keys(vars)) {
		if (secretSet.has(key)) {
			throw new Error(`Secret key leaked into env version payload: ${key}`);
		}
	}
}

/**
 * Return a NEW object containing only the non-secret keys of `vars` (every key
 * present in `secretKeys` is excluded). The input object is NOT mutated.
 */
export function filterSecretVars(vars: Record<string, string>, secretKeys: string[]): Record<string, string> {
	const secretSet = new Set(secretKeys);
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(vars)) {
		if (!secretSet.has(key)) out[key] = value;
	}
	return out;
}
