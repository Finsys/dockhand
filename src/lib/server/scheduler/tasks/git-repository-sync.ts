/**
 * Git Repository Auto-Sync Task
 *
 * Handles automatic syncing and fan-out deploying of git-based repositories.
 */

import type { ScheduleTrigger } from '../../db';
import {
	createScheduleExecution,
	updateScheduleExecution,
	appendScheduleExecutionLog
} from '../../db';
import { deployFromRepositoryWithFanOut } from '../../git';
import { sendEventNotification } from '../../notifications';

/**
 * Execute a git repository sync.
 */
export async function runGitRepositorySync(
	repositoryId: number,
	repositoryName: string,
	triggeredBy: ScheduleTrigger
): Promise<void> {
	const startTime = Date.now();

	// Create execution record
	// Note: environmentId is null since repositories are global, not env-specific
	const execution = await createScheduleExecution({
		scheduleType: 'git_repository_sync',
		scheduleId: repositoryId,
		environmentId: null,
		entityName: repositoryName,
		triggeredBy,
		status: 'running'
	});

	await updateScheduleExecution(execution.id, {
		startedAt: new Date().toISOString()
	});

	const log = (message: string) => {
		console.log(`[Git-repo-sync] ${message}`);
		appendScheduleExecutionLog(execution.id, `[${new Date().toISOString()}] ${message}`);
	};

	const persistStackDetails = async (
		status: 'success' | 'failed' | 'skipped',
		result: { output?: string; stacks?: unknown[]; error?: string },
		errorMessage?: string
	) => {
		await updateScheduleExecution(execution.id, {
			status,
			completedAt: new Date().toISOString(),
			duration: Date.now() - startTime,
			details: { output: result.output, stacks: result.stacks },
			...(errorMessage ? { errorMessage } : {})
		});
	};

	try {
		log(`Starting sync for repository: ${repositoryName}`);

		// Deploy from repository with fan-out logic
		const result = await deployFromRepositoryWithFanOut(repositoryId, log);

		const stacks = result.stacks ?? [];
		const totalStacks = stacks.length;
		const deployedStacks = stacks.filter(s => s.status === 'deployed').length;
		const skippedStacks = stacks.filter(s => s.status === 'skipped').length;
		const failedStacks = stacks.filter(s => s.status === 'failed').length;

		if (failedStacks > 0 || (totalStacks === 0 && !result.success)) {
			// Any failed stack marks the execution failed — a "success" status
			// here would hide the breakdown from the schedules UI. Also treat
			// a repo-level failure with no per-stack results as failed.
			const partial = deployedStacks > 0;
			log(`Sync finished with ${partial ? 'partial ' : ''}errors for repository ${repositoryName}. Total stacks: ${totalStacks} (Deployed: ${deployedStacks}, Skipped: ${skippedStacks}, Failed: ${failedStacks})`);

			await persistStackDetails(
				'failed',
				result,
				result.error || 'Deployment failed'
			);

			await sendEventNotification('git_sync_failed', {
				title: partial ? 'Git repository sync finished with errors' : 'Git repository sync failed',
				message: partial
					? `Repository "${repositoryName}" deployed ${deployedStacks} stack(s), ${failedStacks} failed.`
					: `Repository "${repositoryName}" sync failed: ${result.error || `${failedStacks} stack(s) failed`}`,
				type: partial ? 'warning' : 'error'
			});
		} else if (deployedStacks > 0) {
			log(`Sync completed for repository ${repositoryName}. Total stacks: ${totalStacks} (Deployed: ${deployedStacks}, Skipped: ${skippedStacks}, Failed: ${failedStacks})`);

			await persistStackDetails('success', result);

			await sendEventNotification('git_sync_success', {
				title: 'Git repository synced',
				message: `Repository "${repositoryName}" deployed ${deployedStacks} stack(s) successfully.`,
				type: 'success'
			});
		} else {
			log(`Sync completed for repository ${repositoryName}. Total stacks: ${totalStacks} (Deployed: ${deployedStacks}, Skipped: ${skippedStacks}, Failed: ${failedStacks})`);

			await persistStackDetails('skipped', result);

			await sendEventNotification('git_sync_skipped', {
				title: 'Git repository sync skipped',
				message: totalStacks > 0
					? `Repository "${repositoryName}" sync skipped: no changes detected in ${skippedStacks} stack(s).`
					: `Repository "${repositoryName}" sync skipped: no stacks are linked to this repository.`,
				type: 'info'
			});
		}
	} catch (error: any) {
		log(`Error: ${error.message}`);
		await updateScheduleExecution(execution.id, {
			status: 'failed',
			completedAt: new Date().toISOString(),
			duration: Date.now() - startTime,
			errorMessage: error.message
		});

		// Send notification for failed sync
		await sendEventNotification('git_sync_failed', {
			title: 'Git repository sync failed',
			message: `Repository "${repositoryName}" sync failed: ${error.message}`,
			type: 'error'
		});
	}
}
