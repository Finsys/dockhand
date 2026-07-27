/**
 * backups/operations.ts — the operation record: the durable, user-visible
 * lifecycle of one backup or restore, stored in the shared schedule_executions
 * table. This is the observability + result model: the UI and automation read
 * these rows to know what happened.
 *
 * A record opens as `running`, streams throttled progress + log lines, and
 * closes exactly once with a terminal status DERIVED IN ONE PLACE (see
 * ./operations-core). The startup scrub rewrites any row left `running` by a
 * dead process to `stale`, so an interrupted operation is always resolvable
 * without a transaction — "running at boot" is unambiguously not-completed.
 *
 * The pure decision logic (terminal-status derivation, progress throttle, scrub
 * rule) lives in ./operations-core and is unit-tested there; this module is the
 * thin DB-bound wrapper.
 */
import {
	createScheduleExecution,
	updateScheduleExecution,
	appendScheduleExecutionLog,
	failStaleRunningExecutions,
} from '../db';
import type { OperationKind } from './models';
import {
	deriveTerminalState,
	toExecutionStatus,
	ProgressThrottle,
	isAlwaysPersistedStatus,
	type Outcome,
} from './operations-core';

/** How often (ms) progress updates are persisted. */
const PROGRESS_INTERVAL_MS = 1000;

export interface OpenOptions {
	kind: OperationKind;
	/** Config id for a backup; 0 for a restore (no owning config). */
	scheduleId: number;
	environmentId: number | null;
	entityName: string;
	triggeredBy: 'cron' | 'manual' | 'webhook';
}

/**
 * A live operation record. Created via `openOperation`. Call `progress`/`log`
 * during the run, then `close` exactly once with the outcome. `close` is
 * idempotent-safe: a second call is ignored.
 */
export class Operation {
	private closed = false;
	private throttle = new ProgressThrottle(PROGRESS_INTERVAL_MS);
	private startedAt = Date.now();

	private constructor(
		readonly id: number,
		// A stable prefix for the process log so every op line is greppable in
		// `docker logs` — e.g. `[Backup:postgres#42]` / `[Restore:mystack#7]`.
		private logTag: string,
		private onProgressCb?: (status: string, message: string, detail?: unknown) => void
	) {}

	static async open(opts: OpenOptions, onProgress?: (status: string, message: string, detail?: unknown) => void): Promise<Operation> {
		const row = await createScheduleExecution({
			scheduleType: opts.kind,
			scheduleId: opts.scheduleId,
			environmentId: opts.environmentId,
			entityName: opts.entityName,
			triggeredBy: opts.triggeredBy,
			status: 'running',
		});
		await updateScheduleExecution(row.id, { startedAt: new Date().toISOString() });
		const label = opts.kind === 'backup' ? 'Backup' : opts.kind === 'restore' ? 'Restore' : opts.kind;
		return new Operation(row.id, `[${label}:${opts.entityName}#${row.id}]`, onProgress);
	}

	/** Append a detailed line to the operation log (DB debugging trail) AND mirror it
	 * to the process log (docker logs). The DB copy powers the in-app log viewer; the
	 * docker-logs copy makes the FULL backup/restore trail — every stage, every restic
	 * stdout/stderr line, copy/swap steps — debuggable from `docker logs dockhand` even
	 * when the DB/UI isn't reachable. */
	log(message: string): void {
		console.log(`${this.logTag} ${message}`);
		void appendScheduleExecutionLog(this.id, `[${new Date().toISOString()}] ${message}`);
	}

	/**
	 * Report progress. Always forwards to the live callback (SSE/UI). For the
	 * PERSISTED log we throttle ONLY the high-frequency restic stream (status
	 * 'progress' — the per-file `% done` chatter that would hammer the DB). Every
	 * other status is a low-frequency, meaningful event (stage markers like
	 * metadata/verifying/pruning, the volume list, errors/warnings) and is ALWAYS
	 * persisted — otherwise those lines drop out of the execution log
	 * non-deterministically when they land in a throttle window occupied by restic
	 * spam. (That was a real bug: stage markers vanished from the log under load.)
	 */
	progress(status: string, message: string, detail?: unknown): void {
		if (this.onProgressCb) this.onProgressCb(status, message, detail);
		// DB write stays throttled (restic's per-file `% done` would hammer the row);
		// the process log is NOT — docker logs handle the volume fine, and the user
		// wants the COMPLETE trail (every restic line, every stage) greppable there.
		if (isAlwaysPersistedStatus(status) || this.throttle.shouldWrite()) {
			this.log(message);
		} else {
			console.log(`${this.logTag} ${message}`);
		}
	}

	/**
	 * Close the record with the run's outcome. Writes the derived terminal status,
	 * duration, and details exactly once. `details` carries the machine-readable
	 * result (snapshot id, bytes, error code, …).
	 */
	async close(outcome: Outcome, details?: Record<string, unknown>): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const terminal = deriveTerminalState(outcome);
		// Map the engine's internal terminal status onto the SHARED
		// scheduleExecutions vocabulary (see toExecutionStatus) so a failed backup
		// lands as 'failed' — the value the schedules UI + executions API read —
		// not the engine-internal 'error' the rest of the app doesn't recognise.
		const execStatus = toExecutionStatus(terminal.status, { skipped: (details as any)?.skipped === true });
		const isFailure = execStatus === 'failed';
		await updateScheduleExecution(this.id, {
			status: execStatus,
			completedAt: new Date().toISOString(),
			duration: Date.now() - this.startedAt,
			errorMessage: isFailure ? terminal.message : undefined,
			details: {
				...(details ?? {}),
				...(terminal.errorCode ? { errorCode: terminal.errorCode } : {}),
				...(terminal.message && !isFailure ? { note: terminal.message } : {}),
			},
		});
	}
}

/** Open a new operation record. */
export function openOperation(opts: OpenOptions, onProgress?: (status: string, message: string, detail?: unknown) => void): Promise<Operation> {
	return Operation.open(opts, onProgress);
}

/**
 * Startup scrub: mark any operation left `running`/`queued` by a dead process as
 * a terminal failure so it can't linger forever and inflate "in progress"
 * metrics. Delegates to the shared DB sweep (which sets them failed) — a
 * follow-up may split `stale` from `failed` at the DB layer, but the invariant
 * (no row stays `running` across a restart) holds today.
 */
export async function scrubInterruptedOperations(): Promise<number> {
	return failStaleRunningExecutions();
}
