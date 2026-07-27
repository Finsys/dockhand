/**
 * Repository maintenance tasks — scheduled prune, check, auto-unlock.
 * Run per-destination based on destination policies.
 */

import { runRepoTask, verifyBackup } from '$lib/server/backups';
import { parsePoliciesJson } from '$lib/server/backups/helpers';
import { getBackupDestination } from '$lib/server/db';
import { createScheduleExecution, updateScheduleExecution, appendScheduleExecutionLog } from '$lib/server/db';
import { sendEventNotification } from '$lib/server/notifications';

async function runMaintenanceTask(
	destinationId: number,
	destinationName: string,
	task: 'prune' | 'check',
	scheduleType: 'repo_prune' | 'repo_check',
	triggeredBy: 'cron' | 'manual' = 'cron'
): Promise<void> {
	const label = task === 'prune' ? 'Prune' : 'Check';
	const execution = await createScheduleExecution({
		scheduleType,
		scheduleId: destinationId,
		environmentId: null,
		entityName: `${label}: ${destinationName}`,
		triggeredBy,
		status: 'running'
	});
	await updateScheduleExecution(execution.id, { startedAt: new Date().toISOString() });
	const startTime = Date.now();
	const log = (msg: string) => appendScheduleExecutionLog(execution.id, `[${new Date().toISOString()}] ${msg}`);

	try {
		const dest = await getBackupDestination(destinationId);
		if (!dest) throw new Error('Destination not found');

		console.log(`[Backup] Repo ${task} starting for "${destinationName}" (${triggeredBy})`);

		// Auto-unlock before task if enabled in policies
		const policies = parsePoliciesJson(dest.policies); // (audit #26/#37) safe-degrade + log on malformed
		if (policies.autoUnlock) {
			log('Auto-unlocking repository...');
			await runRepoTask(destinationId, 'unlock');
		}

		log(`Running ${task}...`);
		const result = await runRepoTask(destinationId, task);

		if (result.success) {
			log(`${label} completed: ${result.output}`);
			console.log(`[Backup] Repo ${task} completed for "${destinationName}"`);
			await updateScheduleExecution(execution.id, {
				status: 'success',
				completedAt: new Date().toISOString(),
				duration: Date.now() - startTime
			});
			await sendEventNotification(`${scheduleType}_success` as 'repo_prune_success' | 'repo_check_success', {
				title: `${label} completed — ${destinationName}`,
				message: result.output || `${label} completed successfully`,
				type: 'success'
			});
		} else {
			throw new Error(result.error || `${label} failed`);
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		log(`${label} failed: ${msg}`);
		console.log(`[Backup] Repo ${task} failed for "${destinationName}": ${msg}`);
		await updateScheduleExecution(execution.id, {
			status: 'failed',
			completedAt: new Date().toISOString(),
			duration: Date.now() - startTime,
			errorMessage: msg
		});
		await sendEventNotification(`${scheduleType}_failed` as 'repo_prune_failed' | 'repo_check_failed', {
			title: `${label} failed — ${destinationName}`,
			message: msg,
			type: 'error'
		});
	}
}

export async function runRepoPrune(
	destinationId: number,
	destinationName: string,
	triggeredBy: 'cron' | 'manual' = 'cron'
): Promise<void> {
	return runMaintenanceTask(destinationId, destinationName, 'prune', 'repo_prune', triggeredBy);
}

export async function runRepoCheck(
	destinationId: number,
	destinationName: string,
	triggeredBy: 'cron' | 'manual' = 'cron'
): Promise<void> {
	return runMaintenanceTask(destinationId, destinationName, 'check', 'repo_check', triggeredBy);
}

export async function runRepoVerify(
	destinationId: number,
	destinationName: string,
	dataSubset: string,
	triggeredBy: 'cron' | 'manual' = 'cron'
): Promise<void> {
	const execution = await createScheduleExecution({
		scheduleType: 'repo_verify',
		scheduleId: destinationId,
		environmentId: null,
		entityName: `Verify: ${destinationName}`,
		triggeredBy,
		status: 'running'
	});
	await updateScheduleExecution(execution.id, { startedAt: new Date().toISOString() });
	const startTime = Date.now();
	const log = (msg: string) => appendScheduleExecutionLog(execution.id, `[${new Date().toISOString()}] ${msg}`);

	try {
		const dest = await getBackupDestination(destinationId);
		if (!dest) throw new Error('Destination not found');

		console.log(`[Backup] Repo verify starting for "${destinationName}" (${triggeredBy}, ${dataSubset})`);

		const policies = parsePoliciesJson(dest.policies); // (audit #26/#37) safe-degrade + log on malformed
		if (policies.autoUnlock) {
			log('Auto-unlocking repository...');
			await runRepoTask(destinationId, 'unlock');
		}

		log(`Verifying ${dataSubset} of data...`);
		const result = await verifyBackup(destinationId, {
			dataSubset,
			onProgress: (m) => log(m)
		});

		if (result.success) {
			log(`Verify completed: ${result.output}`);
			console.log(`[Backup] Repo verify completed for "${destinationName}"`);
			await updateScheduleExecution(execution.id, {
				status: 'success',
				completedAt: new Date().toISOString(),
				duration: Date.now() - startTime
			});
			await sendEventNotification('repo_verify_success', {
				title: `Data verify completed — ${destinationName}`,
				message: `Verified ${dataSubset} of data successfully`,
				type: 'success'
			});
		} else {
			throw new Error(result.error || 'Verify failed');
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		log(`Verify failed: ${msg}`);
		console.log(`[Backup] Repo verify failed for "${destinationName}": ${msg}`);
		await updateScheduleExecution(execution.id, {
			status: 'failed',
			completedAt: new Date().toISOString(),
			duration: Date.now() - startTime,
			errorMessage: msg
		});
		await sendEventNotification('repo_verify_failed', {
			title: `Data verify failed — ${destinationName}`,
			message: msg,
			type: 'error'
		});
	}
}
