import {
	createScheduleExecution,
	updateScheduleExecution,
	type ScheduleTrigger
} from './db';
import { appendRunLog, runLogFileName, SizeBudgetTracker } from './deploy-log-store';
import { summarize } from './deploy-summary-core';
import { buildRunDetails, type DeployRunOptions } from './deploy-run-record-core';
import { redactLine } from './secret-redaction';
import type { RunRecorder } from './sse';

/**
 * Stored instead of the raw error text when redactLine() had to withhold the whole
 * line (a too-short secret value matched, and redacting only that substring would
 * risk hitting an unrelated coincidence -- see secret-redaction.ts). A run without an
 * error message is unfortunate; a run with a leaked secret in a widely-readable field
 * is a security incident, so the row still closes "failed", just without the text.
 */
const ERROR_WITHHELD_MESSAGE = 'Deploy failed (error message withheld: contained a secret value)';

/**
 * The database-touching half of the stack_deploy run record. Split from
 * deploy-run-record-core.ts on purpose: this file imports db.ts (createScheduleExecution
 * pulls in better-sqlite3), which is not importable under Bun (ERR_DLOPEN_FAILED). Keeping
 * that import out of the pure -core module is what lets deploy-run-record-core.test.ts run
 * at all, and keeps it from dragging down unrelated test files sharing the same process.
 *
 * F5 fix: the caller-supplied `envId` (the environment the run belongs to, or null for a
 * run not attributed to one) is threaded through to appendRunLog()/SizeBudgetTracker
 * (deploy-log-store.ts) for every filesystem operation this class performs. Before this,
 * `envId` was accepted by createRunRecorder()'s input and stored on the schedule_executions
 * row (environmentId), but never reached the log file's PATH or its size budget -- every
 * environment's deploy output landed in the SAME deploy-logs/ directory and counted against
 * the SAME 2 GiB total (deploy-log-store.ts's BUDGET_BYTES), so a noisy deploy in one
 * environment could silently truncate another environment's deploy logs. See
 * deploy-log-store.ts's SizeBudgetTracker doc comment for the full explanation.
 */

const TRUNCATION_NOTICE = '\n[deploy log truncated: size budget exceeded]\n';

export class DeployRunRecorder implements RunRecorder {
	private readonly executionId: number;
	private readonly runId: string;
	private readonly startedAtMs: number;
	private readonly options: DeployRunOptions;
	private readonly composeHash: string;
	private readonly envHash: string;
	private readonly userId?: number;
	/** F5 fix: which environment this run belongs to (or null) -- determines the ON-DISK
	 *  directory its log file lives in and which environment's size budget it counts
	 *  against (deploy-log-store.ts's logDir()/SizeBudgetTracker). Never used for anything
	 *  else here -- environmentId on the schedule_executions row itself is set separately,
	 *  by createRunRecorder()'s createScheduleExecution() call. */
	private readonly envId: number | null;
	/** Not readonly: addSecrets() extends this after construction -- see its doc comment. */
	private secrets: string[];
	private readonly lines: string[] = [];
	/** Chain of queued appends -- see line()'s doc comment for why this exists. */
	private tail: Promise<void> = Promise.resolve();
	private truncated = false;
	/** Tracks the deploy-logs/ size budget without a full directory re-scan on every
	 *  appended line -- see SizeBudgetTracker's doc comment (deploy-log-store.ts). */
	private readonly sizeBudget: SizeBudgetTracker;

	constructor(
		executionId: number,
		startedAtMs: number,
		input: {
			options: DeployRunOptions;
			composeHash: string;
			envHash: string;
			userId?: number;
			secrets: string[];
			/** F5 fix: see the envId field's doc comment above. */
			envId: number | null;
		},
		/** Test-only seam: lets tests exercise the truncation path with a tiny budget
		 *  instead of writing gigabytes of real log data. createRunRecorder() never
		 *  passes this, so production always gets SizeBudgetTracker's real default
		 *  (BUDGET_BYTES, deploy-log-store.ts). */
		sizeBudget?: SizeBudgetTracker
	) {
		this.executionId = executionId;
		this.runId = String(executionId);
		this.startedAtMs = startedAtMs;
		this.options = input.options;
		this.composeHash = input.composeHash;
		this.envHash = input.envHash;
		this.userId = input.userId;
		this.secrets = input.secrets;
		this.envId = input.envId;
		this.sizeBudget = sizeBudget ?? new SizeBudgetTracker(this.envId, this.runId);
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
		this.tail = this.tail.then(async () => {
			if (this.truncated) return;
			// Pushed for the summary in the SAME guarded step as the file write, not
			// synchronously up in line() -- line() can be called many times before
			// the chain gets to run any of them, and truncation only actually takes
			// effect partway through that queue. Pushing here keeps `this.lines`
			// (what summarize() sees) exactly in sync with what really landed in the
			// file: a line that gets skipped because truncation already kicked in
			// isn't counted as if it had been written.
			this.lines.push(line);
			const chunk = line + '\n';
			await appendRunLog(this.envId, this.runId, chunk);
			// Checked AFTER writing, not before: a budget check ahead of the write
			// would either reject a legitimate line on stale size info, or need a
			// second read straight after anyway. Checking once, right after the
			// write that just happened, is both simpler and exactly what "abort at
			// the end of writing, not truncate mid-line" (design doc §5) asks for.
			// recordAppend() itself only re-scans the directory occasionally (see
			// SizeBudgetTracker) -- it does NOT re-stat the whole deploy-logs/
			// directory on every call, unlike the budgetExceeded() this replaced.
			if (await this.sizeBudget.recordAppend(Buffer.byteLength(chunk, 'utf8'))) {
				this.truncated = true;
				await appendRunLog(this.envId, this.runId, TRUNCATION_NOTICE);
			}
		});
	}

	/**
	 * F4 fix: the caller (a route or deployGitStack) builds this recorder from the
	 * DB-only vars it has BEFORE calling deployStack(), which then resolves the bound
	 * secret provider's bulk/inline-ref values internally (resolveProviderEnvVars,
	 * stacks.ts) -- entirely new values the caller never saw. Without this, a
	 * provider-resolved secret that ends up in compose's raw stderr passes straight
	 * through end()'s redaction (it redacts against `this.secrets` only) and into
	 * errorMessage, which GET /api/schedules/executions returns to every authenticated
	 * user. Callers pass deployStack()'s result.resolvedSecrets here, after the call
	 * returns and before end() is invoked -- see stacks.ts's StackOperationResult.
	 */
	addSecrets(values: string[]): void {
		for (const value of values) {
			if (!this.secrets.includes(value)) this.secrets.push(value);
		}
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

		// error is compose's raw, unredacted stdout/stderr (deploy-recorder.ts's
		// shouldRecord() deliberately excludes the 'result' event from the log file for
		// exactly this reason: it never passes through redactLine). This value goes into
		// errorMessage on schedule_executions, which GET /api/schedules/executions returns
		// to every authenticated user regardless of stack/environment permission -- so it
		// gets the same redaction the streamed lines already got before it's stored.
		const errorMessage = ok
			? null
			: (redactLine(error ?? 'Deploy failed', this.secrets) ?? ERROR_WITHHELD_MESSAGE);

		await updateScheduleExecution(this.executionId, {
			status: ok ? 'success' : 'failed',
			completedAt: new Date().toISOString(),
			duration: Date.now() - this.startedAtMs,
			errorMessage,
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
	/** Every value (secret AND non-secret) that reaches the container -- same set the
	 *  caller already merged for envHash. Used to redact error/summary text on end(),
	 *  same secrets list stacks.ts uses for makeLineForwarder()/makeRedactedLineSink(). */
	secrets: string[];
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
		userId: input.userId,
		secrets: input.secrets,
		// F5 fix: same envId already stored on the schedule_executions row above
		// (environmentId: input.envId) -- also threaded to the recorder so its log
		// file lands in, and counts against the budget of, THIS run's own
		// environment directory. See DeployRunRecorder's envId field doc comment.
		envId: input.envId
	});
}
