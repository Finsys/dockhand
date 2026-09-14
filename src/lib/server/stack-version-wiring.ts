/**
 * Crash-safe stack-version save orchestration + pure env-revert helpers.
 *
 * This is the ORCHESTRATION layer that S02's pure version store (stack-versions)
 * punted to S03:
 *  - a crash-safe save (live-file-first, then version-record, then best-effort
 *    pointer-advance, with the live file rolled back on a version-write failure
 *    so there is never a recorded-but-not-live state),
 *  - the safe-version identification used for prune (the version live at last
 *    deploy is never pruned),
 *  - the pure merge/serialize helpers for env reverts.
 *
 * ## Purity / test-importability (same contract as S02 / MEM016)
 * This module is PURE. It imports only `node:fs` and the pure primitives from
 * `./stack-versions.js` (saveVersion, listVersions, atomicWriteFile,
 * filterSecretVars, parseEnvVars) plus their types. It does NOT import
 * `stacks.ts` / `db.ts` / `better-sqlite3` at the top level — a top-level import
 * of either would load better-sqlite3 (via db/drizzle.ts's seedDatabase) and
 * crash every bun test that imports this module. The real wiring call sites
 * (T02/T03) pass in the actual pointer advancer (upsertStackSourcePointer) and
 * the real secret keys (getStackInjectedSecretKeys) as injectable functions; this
 * module never imports them.
 *
 * ## Crash-safe save ordering
 * `saveStackVersion` writes the LIVE file FIRST (writeLive), THEN records the
 * version (recordVersion), THEN advances the pointer best-effort. Because the
 * live file is written before the version, a hard crash between the two leaves
 * the live file correct (new content) with only a missing version record — never
 * a version that is recorded but not live. On an in-process version-write
 * FAILURE (a thrown error, not a hard crash), the live file is rolled back to its
 * previous content (or unlinked if it did not exist before), so the failure
 * leaves BOTH the live file and the version file at the previous content.
 *
 * ## GIT env stacks
 * For GIT stacks the DB is the live source of env vars (the caller has already
 * written them); there is no live FILE to write. So `livePath` is omitted and
 * `saveStackVersion` records the version + advances the pointer without touching
 * any live file.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import {
	DEFAULT_MAX_VERSIONS,
	atomicWriteFile,
	collapseHistoryFile,
	filterSecretVars,
	listVersions,
	parseEnvVars,
	saveVersion,
	versionContentEquals,
	type SaveVersionOptions,
	type StackVersion,
	type VersionType
} from './stack-versions.js';

// Re-export the pure env parser + default bound so this module is a convenient
// single surface for the versioning primitives the T02/T03 call sites consume.
export { parseEnvVars };
export { DEFAULT_MAX_VERSIONS };

/** Injectable crash-safe save options. Defaults mirror the S02 primitives. */
export interface SaveVersionWiringOptions {
	/** Resolved stack directory (the caller resolves it via getStackDir). */
	stackDir: string;
	/** The version kind: a compose YAML string, or a non-secret env record. */
	type: VersionType;
	/**
	 * The new live content. For `compose` this is the compose YAML string (stored
	 * verbatim). For `env` this is KEY=VALUE .env text — a raw .env for internal
	 * stacks, or a serialized non-secret Record for GIT env — which is parsed and
	 * filtered so the STORED version is secret-free.
	 */
	content: string;
	/**
	 * For `env` versions: the secret key NAMES that must NOT be captured. Supplied
	 * by the caller (getStackInjectedSecretKeys). Secret values live in the DB and
	 * are injected at runtime, so they are filtered out of the stored version.
	 */
	secretKeys?: string[];
	/**
	 * ISO-8601 `last_deployed_at` pointer. The newest version with timestamp <=
	 * this is the "safe" version that is never pruned (the version live at last
	 * deploy). When null/undefined, there is no safe version.
	 */
	lastDeployedAt?: string | null;
	/** Bound applied after appending (defaults to DEFAULT_MAX_VERSIONS). */
	maxVersions?: number;
	/**
	 * Path of the live file to write first (crash-safe ordering). OMIT for GIT env
	 * stacks where the DB is the live source (already written by the caller) — no
	 * live file is written in that case.
	 */
	livePath?: string;
	/**
	 * Advance the (stack, env) version pointer best-effort after a successful
	 * version record. Defaults to a no-op. A pointer-advance failure is swallowed
	 * (it must NOT fail the save).
	 */
	advancePointer?: (values: { lastSavedAt?: string; lastDeployedAt?: string }) => Promise<void>;
	/**
	 * Write the live file. Defaults to `atomicWriteFile`. Only invoked when
	 * `livePath` is provided.
	 */
	writeLive?: (livePath: string, content: string) => void;
	/**
	 * Record a version. Defaults to `saveVersion` (the S02 pure store). The `safe`
	 * version (the one live at last deploy) and, for env, the secret keys are
	 * forwarded so pruning never drops the safe version and a leaked secret fails
	 * loudly.
	 */
	recordVersion?: (
		stackDir: string,
		type: VersionType,
		content: string | Record<string, string>,
		opts: SaveVersionOptions
	) => { id: string; timestamp: string };
}

/** Outcome of a `saveStackVersion` call. */
export interface SaveVersionResult {
	/** The id of the recorded version. */
	id: string;
	/** The ISO-8601 timestamp of the recorded version. */
	timestamp: string;
	/** True when a live file was written (i.e. `livePath` was provided). */
	liveWritten: boolean;
	/** Reserved for a future rollback flag; false on the successful path. */
	rolledBack: boolean;
	/**
	 * True when the save was a NO-OP: the newest recorded version already held
	 * exactly this content, so no version was recorded and `lastSavedAt` was NOT
	 * advanced. `id`/`timestamp` then reference the pre-existing version.
	 */
	skipped: boolean;
}

/**
 * Crash-safe stack-version save orchestration.
 *
 * Ordering:
 * 1. Snapshot the current live file (if `livePath` exists) for rollback.
 * 2. Identify the safe version (live at last deploy) via findSafeVersionId.
 * 3. Write the LIVE file FIRST (omitted when `livePath` is undefined — GIT env).
 * 4. Record the version (secret-free for env). On success, advance the pointer
 *    best-effort (a pointer failure never fails the save).
 * 5. On a version-write FAILURE, roll the live file back to its previous content
 *    (or unlink it if it did not exist before) so both the live file and the
 *    version file remain at the previous content — all-or-nothing.
 *
 * See the module header for the crash-safety rationale.
 */
export async function saveStackVersion(opts: SaveVersionWiringOptions): Promise<SaveVersionResult> {
	const { stackDir, type, content, secretKeys, lastDeployedAt, maxVersions, livePath } = opts;
	const writeLive = opts.writeLive ?? atomicWriteFile;
	const recordVersion = opts.recordVersion ?? saveVersion;
	const advancePointer = opts.advancePointer ?? (async () => undefined);

	// For env, the content is KEY=VALUE text: parse it and strip the secret keys
	// so the STORED version is secret-free. For compose, the content is the YAML
	// string used verbatim.
	const contentForRecord: string | Record<string, string> =
		type === 'env' ? filterSecretVars(parseEnvVars(content), secretKeys ?? []) : content;

	// Snapshot the live file so a version-write failure can roll it back.
	const prevLive = livePath && existsSync(livePath) ? readFileSync(livePath, 'utf8') : null;

	// Identify the version live at last deploy so pruning never drops it.
	const safe = findSafeVersionId(listVersions(stackDir, type), lastDeployedAt);

	// CRASH-SAFE ORDERING: the live file is written FIRST. Omitted when livePath
	// is undefined (GIT env: the DB is the live source, already written by caller).
	if (livePath) {
		writeLive(livePath, content);
	}

	// NO-OP SAVE: when the newest recorded version already holds exactly this
	// content, recording it again would only bloat the bounded history and churn
	// last_saved_at. The edit modal saves BOTH compose and env on every save, so
	// without this the untouched side would add a duplicate entry on every
	// unrelated edit. For env the comparison runs on the stored (parsed,
	// secret-free) form, so comment/whitespace-only .env edits also no-op - but
	// the live file above still picked up the new formatting.
	const latest = listVersions(stackDir, type)[0];
	if (latest && latest.content !== undefined && versionContentEquals(latest.content, contentForRecord)) {
		// Opportunistic normalization: even a skipped (no-op) save collapses any
		// duplicate-content entries the list accumulated (e.g. saved before the
		// distinct-content invariant existed, or by pre-fix code). Best-effort -
		// a cleanup failure never fails the save. No pointer churn, no new entry.
		try {
			collapseHistoryFile(stackDir, type, safe);
		} catch (err) {
			console.warn(`[StackVersion] Failed to collapse duplicate versions (${type}):`, err);
		}
		return {
			id: latest.id,
			timestamp: latest.timestamp,
			liveWritten: !!livePath,
			rolledBack: false,
			skipped: true
		};
	}

	try {
		const recorded = recordVersion(stackDir, type, contentForRecord, {
			safe,
			secretKeys: type === 'env' ? secretKeys : undefined,
			maxVersions: maxVersions ?? DEFAULT_MAX_VERSIONS
		});

		// Advance the pointer best-effort: a pointer failure must NOT fail the save.
		try {
			await advancePointer({ lastSavedAt: recorded.timestamp });
		} catch {
			// Swallow: pointer advance is best-effort; the version is already
			// recorded and the live file is live, so the save itself succeeded.
		}

		return {
			id: recorded.id,
			timestamp: recorded.timestamp,
			liveWritten: !!livePath,
			rolledBack: false,
			skipped: false
		};
	} catch (err) {
		// ALL-OR-NOTHING rollback: restore the live file to its previous content so
		// a mid-write failure leaves BOTH the live file and the version file at the
		// previous content (no recorded-but-not-live state).
		if (livePath) {
			if (prevLive !== null) {
				try {
					writeLive(livePath, prevLive);
				} catch {
					// Best-effort rollback; the original error is rethrown below.
				}
			} else {
				try {
					unlinkSync(livePath);
				} catch {
					// Best-effort: ignore unlink errors (e.g. the file is already gone).
				}
			}
		}
		throw err;
	}
}

/**
 * Identify the version that must NEVER be pruned: the newest version whose
 * timestamp <= `lastDeployedAt` (the version that was live when last deployed).
 *
 * Returns `undefined` when `lastDeployedAt` is null/undefined, or when no stored
 * version has a timestamp <= `lastDeployedAt`. Ties (identical timestamp) are
 * broken by id (larger id wins) for determinism. This value is passed as `safe`
 * to saveVersion/prune so boundVersions preserves it.
 */
export function findSafeVersionId(
	versions: StackVersion[],
	lastDeployedAt?: string | null
): string | undefined {
	if (lastDeployedAt == null) return undefined;
	let best: StackVersion | undefined;
	for (const v of versions) {
		if (v.timestamp > lastDeployedAt) continue;
		if (!best) {
			best = v;
		} else if (v.timestamp > best.timestamp || (v.timestamp === best.timestamp && v.id > best.id)) {
			best = v;
		}
	}
	return best?.id;
}

/**
 * Non-destructive merge for a GIT-stack env revert.
 *
 * `versionRecord` is the version's non-secret Record (secret-free). The result:
 * - every (key, value) in `versionRecord` as `{ key, value, isSecret: false }`
 *   (these OVERRIDE the current values), PLUS
 * - every current var with `isSecret === true` (secrets are PRESERVED verbatim; a
 *   secret key cannot appear in the secret-free `versionRecord`, so every current
 *   secret survives).
 *
 * Current NON-secret vars absent from `versionRecord` are DROPPED (the version is
 * the full non-secret set at that point). The caller feeds this to setStackEnvVars
 * (which deletes-then-inserts the (stack, env) row), so the merged set is exactly
 * what ends up in the DB — no existing secret is ever wiped.
 *
 * Pure: no DB, no fs.
 */
export function computeRevertedEnvVars(
	currentVars: Array<{ key: string; value: string; isSecret: boolean }>,
	versionRecord: Record<string, string>
): Array<{ key: string; value: string; isSecret?: boolean }> {
	const versionKeys = new Set(Object.keys(versionRecord));
	const out: Array<{ key: string; value: string; isSecret?: boolean }> = [];

	// 1. Every (key, value) in the version's non-secret record (overrides current).
	for (const [key, value] of Object.entries(versionRecord)) {
		out.push({ key, value, isSecret: false });
	}

	// 2. Every current secret var is preserved verbatim. A secret key cannot appear
	//    in the secret-free versionRecord, but the guard is cheap and defensive.
	for (const cv of currentVars) {
		if (cv.isSecret === true && !versionKeys.has(cv.key)) {
			out.push({ key: cv.key, value: cv.value, isSecret: true });
		}
	}

	return out;
}

/**
 * Serialize a non-secret Record back to KEY=VALUE .env text (one line per entry,
 * joined with \n) — for writing a version's non-secret record to an internal
 * stack's .env file on revert. Empty record -> empty string.
 */
export function serializeEnvVars(record: Record<string, string>): string {
	return Object.entries(record)
		.map(([key, value]) => `${key}=${value}`)
		.join('\n');
}
