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
 * counting toward recordIds so an already-existing file for them is protected from
 * deletion either way.
 */

import type { ScheduleTrigger, ScheduleStatus } from '../../db';
import {
	getDeployLogReconcileEnabled,
	getScheduleExecutionIdsByType,
	createScheduleExecution,
	updateScheduleExecution,
	appendScheduleExecutionLog
} from '../../db';
import { listRunLogIds, deleteRunLog } from '../../deploy-log-store';
import { planReconcile } from '../../deploy-log-reconcile-core';

// System job ID (own scheduleType, so this never collides with system-cleanup.ts's ids)
export const DEPLOY_LOG_RECONCILE_ID = 1;

/** Records in these states may not have written their log file yet -- see module doc comment. */
const NON_TERMINAL_STATUSES: ScheduleStatus[] = ['queued', 'running'];

/**
 * Execute the deploy-log reconcile job.
 */
export async function runDeployLogReconcileJob(triggeredBy: ScheduleTrigger = 'cron'): Promise<void> {
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
		const fileIds = await listRunLogIds();
		const records = await getScheduleExecutionIdsByType('stack_deploy');
		const recordIds = records.map((r) => String(r.id));

		await log(`Found ${fileIds.length} deploy-log file(s) and ${recordIds.length} stack_deploy record(s)`);

		const plan = planReconcile({ fileIds, recordIds });

		for (const fileId of plan.deleteFiles) {
			await deleteRunLog(fileId);
		}

		const byId = new Map(records.map((r) => [String(r.id), r]));
		let skippedInProgress = 0;
		for (const recordId of plan.markMissing) {
			const record = byId.get(recordId);
			// Still running/queued: it may simply not have written its first line yet
			// (see module doc comment). Leave it alone -- a later reconcile run will
			// catch it correctly once the run has actually finished.
			if (record && NON_TERMINAL_STATUSES.includes(record.status)) {
				skippedInProgress++;
				continue;
			}
			await updateScheduleExecution(Number(recordId), {
				details: { ...(record?.details ?? {}), logMissing: true }
			});
		}
		const markedCount = plan.markMissing.length - skippedInProgress;

		await log(
			`Reconcile complete: ${plan.deleteFiles.length} orphan file(s) deleted, ${markedCount} record(s) marked logMissing` +
				(skippedInProgress > 0 ? `, ${skippedInProgress} still-running record(s) skipped` : '')
		);
		await updateScheduleExecution(execution.id, {
			status: 'success',
			completedAt: new Date().toISOString(),
			duration: Date.now() - startTime,
			details: {
				filesFound: fileIds.length,
				recordsFound: recordIds.length,
				deletedFiles: plan.deleteFiles.length,
				markedRecords: markedCount,
				skippedInProgress
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
