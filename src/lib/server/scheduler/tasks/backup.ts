/**
 * Backup Scheduler Task
 *
 * Handles scheduled backup execution.
 */

import type { ScheduleTrigger } from '../../db';
import { runBackup } from '../../backups';

/**
 * Execute a scheduled backup.
 */
export async function runScheduledBackup(
	configId: number,
	entityName: string,
	environmentId: number | null | undefined,
	triggeredBy: ScheduleTrigger = 'cron'
): Promise<void> {
	console.log(`[Backup] Scheduled backup triggered for config ${configId} (${entityName}) by ${triggeredBy}`);

	const validTrigger = triggeredBy === 'cron' || triggeredBy === 'manual' || triggeredBy === 'webhook'
		? triggeredBy
		: 'manual';

	const result = await runBackup(configId, validTrigger);

	if (result.status === 'success' || result.status === 'warning') {
		console.log(`[Backup] Scheduled backup completed for config ${configId} (${entityName}), snapshot: ${result.snapshotId}`);
	} else if (result.status === 'skipped') {
		// A benign overlap (one already running) — not a failure.
		console.log(`[Backup] Scheduled backup skipped for config ${configId} (${entityName}): ${result.reason}`);
	} else if (result.status === 'error') {
		console.error(`[Backup] Scheduled backup failed for config ${configId} (${entityName}): ${result.error}`);
	}
}
