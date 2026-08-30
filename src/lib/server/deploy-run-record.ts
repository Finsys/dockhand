import {
	createScheduleExecution,
	updateScheduleExecution,
	type ScheduleTrigger
} from './db';
import { appendRunLog, runLogFileName, budgetExceeded } from './deploy-log-store';
import { summarize } from './deploy-summary-core';
import { buildRunDetails, type DeployRunOptions } from './deploy-run-record-core';
import type { RunRecorder } from './sse';

/**
 * The database-touching half of the stack_deploy run record. Split from
 * deploy-run-record-core.ts on purpose: this file imports db.ts (createScheduleExecution
 * pulls in better-sqlite3), which is not importable under Bun (ERR_DLOPEN_FAILED). Keeping
 * that import out of the pure -core module is what lets deploy-run-record-core.test.ts run
 * at all, and keeps it from dragging down unrelated test files sharing the same process.
 */

const TRUNCATION_NOTICE = '\n[deploy log truncated: size budget exceeded]\n';

class DeployRunRecorder implements RunRecorder {
	private readonly executionId: number;
	private readonly runId: string;
	private readonly startedAtMs: number;
	private readonly options: DeployRunOptions;
	private readonly composeHash: string;
	private readonly envHash: string;
	private readonly userId?: number;
	private readonly lines: string[] = [];
	/** Chain of queued appends -- see line()'s doc comment for why this exists. */
	private tail: Promise<void> = Promise.resolve();
	private truncated = false;

	constructor(
		executionId: number,
		startedAtMs: number,
		input: { options: DeployRunOptions; composeHash: string; envHash: string; userId?: number }
	) {
		this.executionId = executionId;
		this.runId = String(executionId);
		this.startedAtMs = startedAtMs;
		this.options = input.options;
		this.composeHash = input.composeHash;
		this.envHash = input.envHash;
		this.userId = input.userId;
	}

	/**
	 * appendRunLog (deploy-log-store.ts) is async; this method is not. Without a
	 * chain, two lines arriving close together could race and land in the file out
	 * of order. Each call hangs its append off the tail of the previous one, so
	 * writes always happen in the order line() was called -- and end() can await
	 * `tail` to know every queued write has actually landed before it closes the row.
	 */
	line(line: string): void {
		if (this.truncated) return;
		this.lines.push(line);
		this.tail = this.tail.then(async () => {
			if (this.truncated) return;
			await appendRunLog(this.runId, line + '\n');
			// Checked AFTER writing, not before: a budget check ahead of the write
			// would either reject a legitimate line on stale size info, or need a
			// second read straight after anyway. Checking once, right after the
			// write that just happened, is both simpler and exactly what "abort at
			// the end of writing, not truncate mid-line" (design doc §5) asks for.
			if (await budgetExceeded()) {
				this.truncated = true;
				await appendRunLog(this.runId, TRUNCATION_NOTICE);
			}
		});
	}

	/**
	 * Called on every path out of the deploy (success, failure, or throw) -- including
	 * when no line() ever arrived, e.g. a deploy that fails before compose produces any
	 * output. That's why this never assumes `this.lines` is non-empty.
	 */
	async end(ok: boolean, exitCode?: number, error?: string): Promise<void> {
		// Wait for every queued append to land before summarizing and closing the
		// row -- otherwise a line still in flight could be missing from the summary,
		// or the row could close before its own last line is actually on disk.
		await this.tail;

		const details = buildRunDetails({
			options: this.options,
			summary: this.lines.length > 0 ? summarize(this.lines) : undefined,
			// A real exit code (from the local/direct compose path) is preferred; the
			// Hawser path doesn't have one to give, so fall back to a code consistent
			// with ok/failed rather than leaving it out.
			exitCode: exitCode ?? (ok ? 0 : 1),
			composeHash: this.composeHash,
			envHash: this.envHash,
			logFile: runLogFileName(this.runId),
			truncated: this.truncated
		});

		// "Who" is best-effort only (design doc §10.5: webhook/cron/startup have no
		// user, and auth can be disabled entirely) -- kept out of buildRunDetails'
		// pure, tested shape and merged in here instead.
		const detailsWithUser = this.userId !== undefined ? { ...details, userId: this.userId } : details;

		await updateScheduleExecution(this.executionId, {
			status: ok ? 'success' : 'failed',
			completedAt: new Date().toISOString(),
			duration: Date.now() - this.startedAtMs,
			errorMessage: ok ? null : (error ?? 'Deploy failed'),
			details: detailsWithUser
		});
	}
}

/**
 * Creates the schedule_executions row for a stack deploy run and returns a RunRecorder
 * that mirrors qualifying progress lines to its log file and closes the row when the
 * deploy is over. See sse.ts for why this is built in the route/here, not in sse.ts itself.
 */
export async function createRunRecorder(input: {
	stackName: string;
	envId: number | null;
	userId?: number;
	triggeredBy: ScheduleTrigger;
	options: DeployRunOptions;
	composeHash: string;
	envHash: string;
}): Promise<RunRecorder> {
	const execution = await createScheduleExecution({
		scheduleType: 'stack_deploy',
		scheduleId: 0, // there is no schedule -- see schema comment "or 0 for system jobs"
		environmentId: input.envId,
		entityName: input.stackName,
		triggeredBy: input.triggeredBy,
		status: 'running'
		// logs stays empty on purpose: the text lives in the file, not this column.
	});

	// createScheduleExecution doesn't accept startedAt (it fills triggeredAt itself) --
	// same two-step shape as the system-cleanup.ts jobs this one is modeled on.
	const startedAtMs = Date.now();
	await updateScheduleExecution(execution.id, {
		startedAt: new Date(startedAtMs).toISOString()
	});

	return new DeployRunRecorder(execution.id, startedAtMs, {
		options: input.options,
		composeHash: input.composeHash,
		envHash: input.envHash,
		userId: input.userId
	});
}
