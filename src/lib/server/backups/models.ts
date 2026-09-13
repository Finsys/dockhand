/**
 * backups/models.ts — the explicit types + result shapes + DTO parsers for the
 * backup/restore rewrite. Pure: no DB, no docker, no restic. Everything here is
 * data and pure functions, safe to import anywhere and to unit-test directly.
 *
 * Design notes:
 *  - restic emits `--json` lines; we parse defensively — every numeric field
 *    coerces to 0 and a non-JSON / wrong-shape line yields `null` rather than
 *    throwing. A garbage progress line must never crash a backup.
 *  - Results are explicit discriminated unions, never a vague boolean.
 *  - Error codes are a small, closed taxonomy so the UI and automation can
 *    branch on the KIND of failure (validation vs transient vs integrity).
 */

// =============================================================================
// Operation lifecycle + result state
// =============================================================================

/** The kind of operation an execution row / journal entry represents. */
export type OperationKind = 'backup' | 'restore';

/**
 * Lifecycle status. `warning` = finished but with a caveat (e.g. restic could
 * not read every file — exit 3). `stale` is set by the startup scrub for a row
 * left `running` when the process died. Terminal: success|warning|error|cancelled|stale.
 */
export type OperationStatus =
	| 'running'
	| 'success'
	| 'warning'
	| 'error'
	| 'cancelled';

/**
 * Closed error taxonomy. The UI shows a human message; automation branches on
 * the code. VALIDATION = user/config error (fix the input); REPO_LOCKED /
 * DOCKER / NETWORK = transient runtime (retry later); RESTIC = restic itself
 * failed; INTEGRITY = the artifact is incomplete/unusable (the scary one);
 * CANCELLED = user aborted; STOPPED_RESTART_FAILED = data is fine but a service
 * we stopped could not be restarted (operator must act).
 */
export type BackupErrorCode =
	| 'VALIDATION'
	| 'REPO_LOCKED'
	| 'REPO_NOT_INITIALIZED'
	| 'WRONG_PASSWORD'
	| 'DOCKER'
	| 'NETWORK'
	| 'RESTIC'
	| 'INTEGRITY'
	| 'CANCELLED'
	| 'STOPPED_RESTART_FAILED'
	| 'CONCURRENCY'
	| 'UNKNOWN';

/** A structured, throwable error carrying a machine code. Thrown by services;
 * caught in one place and mapped to a terminal operation status + details. */
export class BackupError extends Error {
	code: BackupErrorCode;
	/** Extra machine-readable context for the execution row `details`. */
	context?: Record<string, unknown>;
	constructor(code: BackupErrorCode, message: string, context?: Record<string, unknown>) {
		super(message);
		this.name = 'BackupError';
		this.code = code;
		this.context = context;
	}
}

/** Result of a backup run. Explicit — never a bare boolean. */
export type BackupResult =
	| { status: 'success' | 'warning'; executionId: number; snapshotId: string; summary: ResticBackupSummary; warning?: string; retention?: string | Record<string, unknown> | null }
	| { status: 'skipped'; executionId?: number; reason: string }
	| { status: 'error'; executionId?: number; code: BackupErrorCode; error: string };

/**
 * The optional action run AFTER a successful in-place swap. It is best-effort:
 * the volume DATA is already safely restored, so a post-restore failure never
 * rolls the restore back — it only downgrades the result to `warning`.
 */
export interface PostRestoreOutcome {
	action: 'start' | 'recreate' | 'redeploy' | 'none';
	ok: boolean;
	error?: string;
}

/** Result of a restore run. `warning` = the data restored fine but the chosen
 * post-restore action (start/recreate/redeploy) failed — the operator must act. */
export type RestoreResult =
	| { status: 'success'; executionId: number; restoredVolumes: string[]; targetPath?: string; postRestore?: PostRestoreOutcome }
	| { status: 'warning'; executionId: number; restoredVolumes: string[]; postRestore: PostRestoreOutcome }
	| { status: 'skipped'; executionId?: number; reason: string }
	| { status: 'error'; executionId?: number; code: BackupErrorCode; error: string };

// =============================================================================
// Restic invocation result (the one wrapper's return shape)
// =============================================================================

/**
 * The result of running restic (locally or in a helper). NEVER thrown — the
 * wrapper resolves this for every outcome; the CALLER decides what an exit code
 * means. `exitCode === undefined` means we could not determine the exit code
 * (killed helper, daemon hiccup) and MUST be treated as failure.
 */
export interface ResticRun {
	exitCode: number | undefined;
	stdout: string;
	stderr: string;
}

/** True iff a restic run definitively succeeded. `undefined` exit ⇒ NOT ok. */
export function resticOk(run: ResticRun): boolean {
	return run.exitCode === 0;
}

/**
 * restic's `backup` exit 3 = "could not read some source files" — the snapshot
 * is still valid and committed, but incomplete. We treat it as a warning, not a
 * failure (matches backrest ErrPartialBackup and zerobyte's exit-3 handling).
 */
export function resticPartial(run: ResticRun): boolean {
	return run.exitCode === 3;
}

// =============================================================================
// Restic JSON DTOs + defensive parsers
// =============================================================================

/** Parsed `message_type: "summary"` line from `restic backup --json`. */
export interface ResticBackupSummary {
	snapshotId: string;
	filesNew: number;
	filesChanged: number;
	filesUnmodified: number;
	dataAdded: number;
	totalBytesProcessed: number;
	totalFilesProcessed: number;
}

/** A `message_type: "status"` progress line. */
export interface ResticProgress {
	percentDone: number; // 0..1
	bytesDone: number;
	totalBytes: number;
}

function num(v: unknown): number {
	return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Parse one NDJSON line from restic. Returns the parsed object or null (never throws). */
export function parseResticLine(line: string): Record<string, unknown> | null {
	const t = line.trim();
	if (!t || t[0] !== '{') return null;
	try {
		const o = JSON.parse(t);
		return o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** Extract the backup summary from restic `--json` stdout, or null if absent.
 * A missing summary means the outcome is unknown, so the caller fails the
 * backup. Numeric fields default to 0 so a truncated summary never throws. */
export function parseResticBackupSummary(stdout: string): ResticBackupSummary | null {
	for (const line of stdout.split('\n')) {
		const o = parseResticLine(line);
		if (o && o.message_type === 'summary' && typeof o.snapshot_id === 'string' && o.snapshot_id) {
			return {
				snapshotId: o.snapshot_id,
				filesNew: num(o.files_new),
				filesChanged: num(o.files_changed),
				filesUnmodified: num(o.files_unmodified),
				dataAdded: num(o.data_added),
				totalBytesProcessed: num(o.total_bytes_processed),
				totalFilesProcessed: num(o.total_files_processed),
			};
		}
	}
	return null;
}

/** Extract a progress update from a restic status line, or null. */
export function parseResticProgress(line: string): ResticProgress | null {
	const o = parseResticLine(line);
	if (o && o.message_type === 'status') {
		return { percentDone: num(o.percent_done), bytesDone: num(o.bytes_done), totalBytes: num(o.total_bytes) };
	}
	return null;
}

/** A snapshot as returned by `restic snapshots --json`. */
export interface Snapshot {
	id: string;
	shortId: string;
	time: string;
	hostname: string;
	tags: string[];
	paths: string[];
}

/** Parse `restic snapshots --json` stdout into Snapshot[], newest first. Returns
 * [] on any parse failure (an unparseable list must NOT look like a populated
 * repo — callers that need to distinguish empty-vs-error check exit code first). */
export function parseSnapshots(stdout: string): Snapshot[] {
	let arr: unknown;
	try { arr = JSON.parse(stdout); } catch { return []; }
	if (!Array.isArray(arr)) return [];
	const out: Snapshot[] = [];
	for (const s of arr) {
		if (!s || typeof s !== 'object') continue;
		const o = s as Record<string, unknown>;
		if (typeof o.id !== 'string') continue;
		out.push({
			id: o.id,
			shortId: typeof o.short_id === 'string' ? o.short_id : o.id.slice(0, 8),
			time: typeof o.time === 'string' ? o.time : '',
			hostname: typeof o.hostname === 'string' ? o.hostname : '',
			tags: Array.isArray(o.tags) ? (o.tags as unknown[]).filter((t): t is string => typeof t === 'string') : [],
			paths: Array.isArray(o.paths) ? (o.paths as unknown[]).filter((p): p is string => typeof p === 'string') : [],
		});
	}
	out.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
	return out;
}


// =============================================================================
// Snapshot tags — STABLE IDs, never normalized names
// =============================================================================

/**
 * The tags every backup snapshot carries. Scoping decisions (retention,
 * ownership, env-access) use ONLY the stable-id tags; the name/type tags are
 * decoration for humans browsing with the restic CLI.
 *
 * Why stable ids, not names: a normalized env name collides when two env names normalize to the
 * same string, which would cross-prune retention and resolve env-access to the wrong environment.
 * Ids never collide.
 */
export type BackupTargetType = 'container' | 'stack';

export function buildSnapshotTags(input: {
	instanceId: string;
	configId: number;
	environmentId: number | null;
	targetName: string;
	type: BackupTargetType;
}): string[] {
	return [
		`dockhand:instance=${input.instanceId}`,
		`dockhand:configid=${input.configId}`,
		`dockhand:envid=${input.environmentId ?? 'local'}`,
		// human-readable decoration (NOT used for any scoping decision):
		`dockhand:type=${input.type}`,
		`dockhand:name=${input.targetName}`,
	];
}

/** The tag filter that selects exactly this config's snapshots for retention.
 * restic ANDs comma-joined tags. instance + configid together are the stable,
 * collision-proof scope. */
export function retentionTagFilter(instanceId: string, configId: number): string {
	return `dockhand:instance=${instanceId},dockhand:configid=${configId}`;
}

/** The tag filter that asserts THIS instance owns a snapshot. */
export function instanceTagFilter(instanceId: string): string {
	return `dockhand:instance=${instanceId}`;
}

/** Read the owning environment id from a snapshot's tags. Returns
 * `'local'`, a numeric id, or null if the tag is absent/malformed (⇒ fail closed). */
export function readEnvIdFromTags(tags: string[]): number | 'local' | null {
	for (const t of tags) {
		if (t.startsWith('dockhand:envid=')) {
			const v = t.slice('dockhand:envid='.length);
			if (v === 'local') return 'local';
			const n = Number(v);
			return Number.isInteger(n) && n > 0 ? n : null;
		}
	}
	return null;
}

/** Read the owning config id from a snapshot's tags. */
export function readConfigIdFromTags(tags: string[]): number | null {
	for (const t of tags) {
		if (t.startsWith('dockhand:configid=')) {
			const n = Number(t.slice('dockhand:configid='.length));
			return Number.isInteger(n) && n > 0 ? n : null;
		}
	}
	return null;
}

// =============================================================================
// Timeout tiers
// =============================================================================

/** Restic operations are UNBOUNDED by default (0 = no timeout). A large backup or a
 * slow listing on a big/remote repo legitimately runs for a long time; a fixed wall-clock
 * cap killed healthy work mid-run (#1382). A stuck op is handled by manual cancel (the
 * helper is a named container killed by cancelBackup, and every run shows as `running` in
 * the execution log) and the helper reaper — the same model backrest/zerobyte use (neither
 * times out a backup). ONE env caps everything: `RESTIC_TIMEOUT` (milliseconds, 0 = off)
 * applies to every restic operation - the host `restic` spawn AND the helper container.
 * The tiers stay in the call API only as a log label; they no longer carry separate
 * limits (previously RESTIC_MAINTENANCE_TIMEOUT set the data tier; folded into one). */
const RESTIC_TIMEOUT_MS = Number(process.env.RESTIC_TIMEOUT ?? 0);
export const TIMEOUTS = {
	interactive: RESTIC_TIMEOUT_MS,
	data: RESTIC_TIMEOUT_MS,
} as const;

export type TimeoutTier = keyof typeof TIMEOUTS;

/** The SINGLE definition of "this restic repository is a local filesystem path" (vs a
 * rest:/s3:/... scheme URL). Local = an ABSOLUTE path, the only form the save gate
 * (isAllowedRepository) accepts. Every site that binds/guards/chowns the local repo MUST
 * use this so they can't diverge - a `./`-vs-`/` mismatch would guard a path the helper
 * never mounts, hard-failing a valid repo with a misleading "repository not found". */
export function isLocalRepo(repository: string): boolean {
	return repository.startsWith('/');
}
