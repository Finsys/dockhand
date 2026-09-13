/**
 * backups/operations-core.ts — the PURE decision logic of the operation record:
 * how a service's outcome maps to a terminal status, how progress writes are
 * throttled, and which rows the startup scrub rewrites. No DB, no timers — so
 * these are unit-testable directly. The DB-bound recorder lives in ./operations.
 *
 * The operation record is the single source of truth for "what happened" — it is
 * what the UI and automation read. Its terminal status is derived in ONE place
 * (here) from the outcome the service returns, so status logic never scatters
 * through the flow.
 */
import type { OperationStatus, BackupErrorCode } from './models';

/** The outcome a service hands back for status derivation. */
export type Outcome =
	| { kind: 'ok' }
	| { kind: 'warning'; message: string }
	| { kind: 'error'; code: BackupErrorCode; message: string }
	| { kind: 'cancelled'; message?: string };

/** The terminal status + human message + machine details for an outcome. */
export interface TerminalState {
	status: Extract<OperationStatus, 'success' | 'warning' | 'error' | 'cancelled'>;
	message?: string;
	errorCode?: BackupErrorCode;
}

/**
 * Map a service outcome to a terminal operation state. This is the ONLY place a
 * terminal status is decided.
 */
export function deriveTerminalState(outcome: Outcome): TerminalState {
	switch (outcome.kind) {
		case 'ok':
			return { status: 'success' };
		case 'warning':
			return { status: 'warning', message: outcome.message };
		case 'cancelled':
			return { status: 'cancelled', message: outcome.message ?? 'Cancelled' };
		case 'error':
			return { status: 'error', message: outcome.message, errorCode: outcome.code };
	}
}

/**
 * The status vocabulary of the SHARED `scheduleExecutions` table — the durable
 * log the schedules UI + executions API read, common to backups, container
 * updates, git sync, image prune, etc. NOTE this is deliberately NOT the backup
 * engine's internal OperationStatus: it has `failed` (not `error`) and no
 * `cancelled`/`stale`.
 */
export type ExecutionStatus = 'queued' | 'running' | 'success' | 'warning' | 'failed' | 'skipped';

/**
 * Map a backup engine terminal status onto the shared executions-table
 * vocabulary. The engine speaks `error`/`cancelled`; the table (and the UI's
 * "failed" filter) speak `failed`. A concurrency reject is flagged by the caller
 * via `skipped` and lands as `skipped`. Keeping this in ONE named, testable place
 * stops a failed backup from being written as `error` — a value the schedules UI
 * filter does not recognise.
 */
export function toExecutionStatus(
	terminalStatus: TerminalState['status'],
	opts: { skipped?: boolean } = {},
): ExecutionStatus {
	if (opts.skipped) return 'skipped';
	switch (terminalStatus) {
		case 'success': return 'success';
		case 'warning': return 'warning';
		case 'error':
		case 'cancelled': return 'failed';
	}
}

/**
 * Debounce decision for progress writes. Persisting every restic status line
 * would hammer the DB, so we write the first update immediately and then at most
 * once per `intervalMs`. Given the last-written timestamp and now, returns
 * whether to write now. `lastWrittenAt === null` (first update) always writes.
 */
export function shouldWriteProgress(lastWrittenAt: number | null, now: number, intervalMs: number): boolean {
	if (lastWrittenAt === null) return true;
	return now - lastWrittenAt >= intervalMs;
}

/**
 * Only the high-frequency restic stream (status 'progress' — per-file `% done`
 * chatter) is rate-limited before being persisted to the execution log. EVERY
 * other status is a low-frequency, meaningful event (stage markers, the volume
 * list, errors/warnings) and must ALWAYS be persisted — otherwise those lines
 * drop out of the log non-deterministically when they collide with a throttle
 * window occupied by restic spam. Returns true when the line must bypass the
 * throttle and always be written.
 */
export function isAlwaysPersistedStatus(status: string): boolean {
	return status !== 'progress';
}

/** A tiny stateful progress throttle built on shouldWriteProgress. `now()` is
 * injectable so tests don't depend on the wall clock. */
export class ProgressThrottle {
	private lastWrittenAt: number | null = null;
	constructor(
		private intervalMs: number,
		private now: () => number = () => Date.now()
	) {}

	/** True if a progress update should be persisted now (and records the time). */
	shouldWrite(): boolean {
		const t = this.now();
		if (shouldWriteProgress(this.lastWrittenAt, t, this.intervalMs)) {
			this.lastWrittenAt = t;
			return true;
		}
		return false;
	}
}
