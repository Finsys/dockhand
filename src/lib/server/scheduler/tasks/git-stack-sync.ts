/**
 * Git Stack Auto-Sync Task
 *
 * Handles automatic syncing and deploying of git-based compose stacks.
 */

import type { ScheduleTrigger } from '../../db';
import {
	createScheduleExecution,
	updateScheduleExecution,
	appendScheduleExecutionLog
} from '../../db';
import { deployGitStack } from '../../git';
import { isStackMigrating } from '../../git-migration-guard';

/**
 * Execute a git stack sync.
 */
export async function runGitStackSync(
	stackId: number,
	stackName: string,
	environmentId: number | null | undefined,
	triggeredBy: ScheduleTrigger
): Promise<void> {
	const startTime = Date.now();

	// A per-stack migration is draining/provisioning this stack's clone and will
	// rm -rf git-repos/stack-<id> at cutover: skip system-triggered syncs so a
	// cron tick cannot re-clone the directory out from under the job. The
	// migration drain has already waited for anything that was in flight before
	// it started. Checked BEFORE the execution record is created.
	if (await isStackMigrating(stackId)) {
		console.log(`[Git-sync] Skipping stack "${stackName}": a git stack migration is in progress for it`);
		return;
	}

	// Create execution record
	const execution = await createScheduleExecution({
		scheduleType: 'git_stack_sync',
		scheduleId: stackId,
		environmentId: environmentId ?? null,
		entityName: stackName,
		triggeredBy,
		status: 'running'
	});

	await updateScheduleExecution(execution.id, {
		startedAt: new Date().toISOString()
	});

	const log = (message: string) => {
		console.log(`[Git-sync] ${message}`);
		appendScheduleExecutionLog(execution.id, `[${new Date().toISOString()}] ${message}`);
	};

	try {
		log(`Starting sync for stack: ${stackName}`);

		// Deploy the git stack (only if there are changes). deployGitStack now emits the
		// git_sync_success/failed/skipped notification itself, so EVERY caller (webhook,
		// manual, this scheduler) notifies uniformly — we no longer dispatch here (#1295).
		const result = await deployGitStack(stackId, { force: false });

		if (result.success) {
			if (result.skipped) {
				log(`No changes detected for stack: ${stackName}, skipping redeploy`);
			} else {
				log(`Successfully deployed stack: ${stackName}`);
			}
			if (result.output) log(result.output);

			await updateScheduleExecution(execution.id, {
				status: result.skipped ? 'skipped' : 'success',
				completedAt: new Date().toISOString(),
				duration: Date.now() - startTime,
				details: { output: result.output }
			});
		} else {
			throw new Error(result.error || 'Deployment failed');
		}
	} catch (error: any) {
		log(`Error: ${error.message}`);
		await updateScheduleExecution(execution.id, {
			status: 'failed',
			completedAt: new Date().toISOString(),
			duration: Date.now() - startTime,
			errorMessage: error.message
		});
		// Notification is emitted by deployGitStack (git_sync_failed); not re-sent here.
	}
}
