/**
 * Deploy Log Reconcile Task
 *
 * Compares deploy-log files on disk (deploy-log-store.ts) against stack_deploy run
 * records in the database and reconciles the two: a file with no record is deleted (an
 * orphan with nothing left to explain it); a record with no file is only marked via
 * details.logMissing -- never deleted, since the metadata (when, who, what was built,
 * which digest) stays valuable even once the log text is gone. See
 * deploy-log-reconcile-core.ts for the decision itself; this file only gathers the two
 * id sets, guards the one case planReconcile can't know about (see below), and carries
 * out the resulting plan.
 *
 * F5 fix -- reconciled PER ENVIRONMENT, never across environments: deploy-log-store.ts
 * now keeps one log directory per environment (envDirName()/logDir()), because a SHARED
 * directory and a SHARED size budget let a noisy deploy in one environment silently
 * truncate another environment's deploy logs. This job has to honor that same boundary,
 * or it would reintroduce the exact cross-environment mixing the size-budget fix closes
 * -- e.g. deleting environment B's file because it happens to share a numeric run id
 * with an orphan in environment A, or marking environment A's record logMissing because
 * environment B happens to hold a same-numbered file. Every id set this file gathers
 * (files AND records) is therefore grouped by environment FIRST, and planReconcile()
 * (the pure decision core) is called ONCE PER ENVIRONMENT, on that environment's own two
 * sets only -- never once on everything flattened together.
 *
 * The set of environments to look at comes from BOTH sides on purpose:
 *   - listEnvDirNames() (deploy-log-store.ts) -- every environment that currently has
 *     ANY file on disk, including one that was later deleted from the database (its
 *     orphaned files must still be reconciled, so its directory must still be visited).
 *   - every DISTINCT environmentId among the stack_deploy records themselves -- an
 *     environment whose only record has no file at all would otherwise never appear
 *     via listEnvDirNames() (there is no directory for it to discover), and its record
 *     would never be considered for markMissing.
 * The union of the two is walked once each; a directory name that cannot be parsed back
 * into an environment id (parseEnvDirName()) is skipped defensively rather than crashing
 * the whole job -- see the per-environment loop below.
 *
 * Record source, verified against Task 10's actual code (deploy-run-record.ts, read
 * directly from a sibling clone -- Task 10 had not landed on this branch at the time
 * this file was written, so it could not be imported here): createRunRecorder() creates
 * a schedule_executions row with scheduleType 'stack_deploy', scheduleId 0 (there is no
 * schedule, only individual runs), and DeployRunRecorder sets `this.runId =
 * String(executionId)` -- exactly the id this file reads via
 * getScheduleExecutionIdsByType('stack_deploy') and converts with String(r.id). Confirmed
 * correct, not assumed.
 *
 * That same reading surfaced a real race this job has to guard against: the row is
 * created with status 'running' BEFORE the deploy has produced a single line, and the
 * log file itself only comes into existence on the first DeployRunRecorder.line() call
 * (appendRunLog() -- deploy-log-store.ts). So there is a real, if narrow, window where a
 * 'running' record legitimately has no file yet. A naive reconcile firing in that window
 * would mark a deploy that is actively in progress as logMissing -- and nothing in this
 * job ever re-checks or clears that flag once the file does show up, so the record would
 * carry a false "log missing" forever. Records still in a non-terminal state ('queued'/
 * 'running') are therefore excluded from markMissing candidacy below, while still
 * counting toward recordIds (within their own environment's set) so an already-existing
 * file for them is protected from deletion either way.
 *
 * Each element in both loops below is wrapped in its own try/catch. Without that, one
 * throwing deleteRunLog/updateScheduleExecution call would abort the whole run -- and
 * since the failing file/record is never removed/marked, every LATER run would fail at
 * the exact same element again, permanently. Reported and reproduced independently: a
 * harmless orphan file ordered before a failing one was still removed, everything after
 * it was not, and the failed run's own `details` came back `null` -- no record of what
 * had actually happened. Per-element isolation plus real counts (see below) fixes both --
 * and now applies WITHIN each environment's own loop, so a failure in one environment's
 * reconciliation cannot stop a later environment's elements from being tried either.
 */

import type { ScheduleTrigger } from '../../db';
import {
	getDeployLogReconcileEnabled,
	getScheduleExecutionIdsByType,
	createScheduleExecution,
	updateScheduleExecution,
	appendScheduleExecutionLog
} from '../../db';
import { listEnvDirNames, listRunLogIds, deleteRunLog, envDirName, parseEnvDirName } from '../../deploy-log-store';
import { planReconcile, isEligibleForMissingMark } from '../../deploy-log-reconcile-core';

// System job ID (own scheduleType, so this never collides with system-cleanup.ts's ids)
export const DEPLOY_LOG_RECONCILE_ID = 1;

/**
 * The three filesystem calls this job makes, injectable so a test can force one element
 * to fail while its neighbours succeed, and so a test can populate a fake per-environment
 * file layout without touching the real filesystem.
 *
 * They are parameters rather than a mock.module() of '../../deploy-log-store' because that
 * call freezes the module's export shape for the WHOLE test process: deploy-run-record.ts
 * imports appendRunLog/runLogFileName/SizeBudgetTracker from the same specifier, and a
 * partial factory left those missing for every module that resolved it afterwards.
 */
export interface DeployLogReconcileDeps {
	listEnvDirNames: () => Promise<string[]>;
	listRunLogIds: (envId: number | null) => Promise<string[]>;
	deleteRunLog: (envId: number | null, runId: string) => Promise<void>;
}

const defaultDeps: DeployLogReconcileDeps = { listEnvDirNames, listRunLogIds, deleteRunLog };

/**
 * Execute the deploy-log reconcile job.
 */
export async function runDeployLogReconcileJob(
	triggeredBy: ScheduleTrigger = 'cron',
	deps: DeployLogReconcileDeps = defaultDeps
): Promise<void> {
	// Check if reconcile is enabled (skip check if manually triggered)
	if (triggeredBy === 'cron') {
		const enabled = await getDeployLogReconcileEnabled();
		if (!enabled) {
			return; // Skip execution if disabled
		}
	}

	const startTime = Date.now();

	// Create execution record
	const execution = await createScheduleExecution({
		scheduleType: 'deploy_log_reconcile',
		scheduleId: DEPLOY_LOG_RECONCILE_ID,
		environmentId: null,
		entityName: 'Deploy log reconcile',
		triggeredBy,
		status: 'running'
	});

	await updateScheduleExecution(execution.id, {
		startedAt: new Date().toISOString()
	});

	const log = async (message: string) => {
		console.log(`[Deploy Log Reconcile] ${message}`);
		await appendScheduleExecutionLog(execution.id, `[${new Date().toISOString()}] ${message}`);
	};

	try {
		const records = await getScheduleExecutionIdsByType('stack_deploy');

		// F5 fix: group records by their OWN environment (via envDirName -- the same
		// directory-name mapping deploy-log-store.ts uses on the filesystem side), so
		// each environment's records are only ever compared against that SAME
		// environment's files below -- never another environment's.
		const recordsByEnvKey = new Map<string, typeof records>();
		for (const record of records) {
			const key = envDirName(record.environmentId);
			const list = recordsByEnvKey.get(key);
			if (list) list.push(record);
			else recordsByEnvKey.set(key, [record]);
		}

		// The set of environments to actually visit: every environment that has a
		// directory on disk (covers orphan files for an environment that no longer
		// has ANY record, e.g. a deleted environment) UNION every environment that has
		// at least one record (covers a record whose file has never been written, so
		// there is no directory for listEnvDirNames() to discover it by -- see the
		// module doc comment).
		const envKeysOnDisk = await deps.listEnvDirNames();
		const envKeys = new Set<string>([...envKeysOnDisk, ...recordsByEnvKey.keys()]);

		let filesFoundTotal = 0;
		// Actually-performed counts, not the plan's sizes -- a failing element must not
		// be counted as done, and must not stop the elements after it (in this SAME
		// environment, or in a LATER environment) from being tried.
		let deletedCount = 0;
		let markedCount = 0;
		let skippedInProgress = 0;
		let failedCount = 0;

		for (const envKey of envKeys) {
			let envId: number | null;
			try {
				envId = parseEnvDirName(envKey);
			} catch {
				// A directory under deploy-logs/ that isn't one of envDirName()'s own
				// outputs (e.g. an unrelated file or a hand-created directory) is not an
				// environment this job knows how to reconcile -- skipped defensively
				// rather than crashing the whole run over it.
				await log(`Skipping unrecognized deploy-logs entry: ${envKey}`);
				continue;
			}

			const envRecords = recordsByEnvKey.get(envKey) ?? [];
			const recordIds = envRecords.map((r) => String(r.id));
			const fileIds = await deps.listRunLogIds(envId);
			filesFoundTotal += fileIds.length;

			const plan = planReconcile({ fileIds, recordIds });

			for (const fileId of plan.deleteFiles) {
				try {
					await deps.deleteRunLog(envId, fileId);
					deletedCount++;
				} catch (error: any) {
					failedCount++;
					await log(`Failed to delete orphan file for run ${fileId} (environment ${envKey}): ${error.message}`);
				}
			}

			const byId = new Map(envRecords.map((r) => [String(r.id), r]));
			for (const recordId of plan.markMissing) {
				const record = byId.get(recordId);
				// Still running/queued: it may simply not have written its first line yet
				// (see module doc comment). Leave it alone -- a later reconcile run will
				// catch it correctly once the run has actually finished.
				if (record && !isEligibleForMissingMark(record.status)) {
					skippedInProgress++;
					continue;
				}
				try {
					await updateScheduleExecution(Number(recordId), {
						details: { ...(record?.details ?? {}), logMissing: true }
					});
					markedCount++;
				} catch (error: any) {
					failedCount++;
					await log(`Failed to mark record ${recordId} as logMissing (environment ${envKey}): ${error.message}`);
				}
			}
		}

		await log(
			`Found ${filesFoundTotal} deploy-log file(s) across ${envKeys.size} environment(s) and ${records.length} stack_deploy record(s)`
		);
		await log(
			`Reconcile complete: ${deletedCount} orphan file(s) deleted, ${markedCount} record(s) marked logMissing` +
				(skippedInProgress > 0 ? `, ${skippedInProgress} still-running record(s) skipped` : '') +
				(failedCount > 0 ? `, ${failedCount} element(s) failed` : '')
		);
		await updateScheduleExecution(execution.id, {
			// A run that hit per-element failures did complete, but not cleanly -- it
			// should not read as indistinguishable from one that had nothing go wrong.
			// 'warning' is exactly this repo's convention for "completed with a caveat"
			// (see the ScheduleStatus doc comment in db.ts), as opposed to 'failed',
			// which here is reserved for the run itself throwing (the outer catch below).
			status: failedCount > 0 ? 'warning' : 'success',
			completedAt: new Date().toISOString(),
			duration: Date.now() - startTime,
			details: {
				filesFound: filesFoundTotal,
				recordsFound: records.length,
				deletedFiles: deletedCount,
				markedRecords: markedCount,
				skippedInProgress,
				failed: failedCount
			}
		});
	} catch (error: any) {
		await log(`Error: ${error.message}`);
		await updateScheduleExecution(execution.id, {
			status: 'failed',
			completedAt: new Date().toISOString(),
			duration: Date.now() - startTime,
			errorMessage: error.message
		});
	}
}
