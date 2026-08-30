/**
 * Deploy Log Reconcile Task
 *
 * Compares deploy-log files on disk (deploy-log-store.ts) against stack_deploy run
 * records in the database and reconciles the two: a file with no record is deleted (an
 * orphan with nothing left to explain it); a record with no file is only marked via
 * details.logMissing -- never deleted, since the metadata (when, who, what was built,
 * which digest) stays valuable even once the log text is gone. See
 * deploy-log-reconcile-core.ts for the decision itself; this file only gathers the two
 * id sets and carries out the resulting plan.
 *
 * ASSUMPTION, not yet verified against a real write path: this reads run records via
 * scheduleType 'stack_deploy' and treats String(schedule_executions.id) as the run id
 * used for the deploy-log filename (runLogFileName()/runLogPath() in
 * deploy-log-store.ts). Nothing in this branch currently creates such a row --
 * that is Task 10's createRunRecorder, which had not landed at the time this file was
 * written. If Task 10 links the log file to a run by a different id, this file's
 * getScheduleExecutionIdsByType('stack_deploy') call and the String(id) conversion
 * below need to be revisited together.
 */

import type { ScheduleTrigger } from '../../db';
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

		const detailsById = new Map(records.map((r) => [String(r.id), r.details]));
		for (const recordId of plan.markMissing) {
			const id = Number(recordId);
			const existingDetails = detailsById.get(recordId) ?? null;
			await updateScheduleExecution(id, {
				details: { ...(existingDetails ?? {}), logMissing: true }
			});
		}

		await log(
			`Reconcile complete: ${plan.deleteFiles.length} orphan file(s) deleted, ${plan.markMissing.length} record(s) marked logMissing`
		);
		await updateScheduleExecution(execution.id, {
			status: 'success',
			completedAt: new Date().toISOString(),
			duration: Date.now() - startTime,
			details: {
				filesFound: fileIds.length,
				recordsFound: recordIds.length,
				deletedFiles: plan.deleteFiles.length,
				markedRecords: plan.markMissing.length
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
