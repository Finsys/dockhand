/**
 * System Cleanup Tasks
 *
 * Handles system cleanup jobs (schedule executions, container events).
 */

import type { ScheduleTrigger } from '../../db';
import {
	getScheduleRetentionDays,
	cleanupOldExecutions,
	getEventRetentionDays,
	getScheduleCleanupEnabled,
	getEventCleanupEnabled,
	getScannerCleanupEnabled,
	createScheduleExecution,
	updateScheduleExecution,
	appendScheduleExecutionLog
} from '../../db';

// System job IDs
export const SYSTEM_SCHEDULE_CLEANUP_ID = 1;
export const SYSTEM_EVENT_CLEANUP_ID = 2;
export const SYSTEM_VOLUME_HELPER_CLEANUP_ID = 3;
export const SYSTEM_SCANNER_CLEANUP_ID = 4;

/**
 * Execute schedule execution cleanup job.
 */
export async function runScheduleCleanupJob(triggeredBy: ScheduleTrigger = 'cron'): Promise<void> {
	// Check if cleanup is enabled (skip check if manually triggered)
	if (triggeredBy === 'cron') {
		const enabled = await getScheduleCleanupEnabled();
		if (!enabled) {
			return; // Skip execution if disabled
		}
	}

	const startTime = Date.now();

	// Create execution record
	const execution = await createScheduleExecution({
		scheduleType: 'system_cleanup',
		scheduleId: SYSTEM_SCHEDULE_CLEANUP_ID,
		environmentId: null,
		entityName: 'Schedule execution cleanup',
		triggeredBy,
		status: 'running'
	});

	await updateScheduleExecution(execution.id, {
		startedAt: new Date().toISOString()
	});

	const log = async (message: string) => {
		console.log(`[Schedule Cleanup] ${message}`);
		await appendScheduleExecutionLog(execution.id, `[${new Date().toISOString()}] ${message}`);
	};

	try {
		const retentionDays = await getScheduleRetentionDays();
		await log(`Starting cleanup with ${retentionDays} day retention`);

		await cleanupOldExecutions(retentionDays);

		await log('Cleanup completed successfully');
		await updateScheduleExecution(execution.id, {
			status: 'success',
			completedAt: new Date().toISOString(),
			duration: Date.now() - startTime,
			details: { retentionDays }
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

/**
 * Execute event cleanup job.
 */
export async function runEventCleanupJob(triggeredBy: ScheduleTrigger = 'cron'): Promise<void> {
	// Check if cleanup is enabled (skip check if manually triggered)
	if (triggeredBy === 'cron') {
		const enabled = await getEventCleanupEnabled();
		if (!enabled) {
			return; // Skip execution if disabled
		}
	}

	const startTime = Date.now();

	// Create execution record
	const execution = await createScheduleExecution({
		scheduleType: 'system_cleanup',
		scheduleId: SYSTEM_EVENT_CLEANUP_ID,
		environmentId: null,
		entityName: 'Container event cleanup',
		triggeredBy,
		status: 'running'
	});

	await updateScheduleExecution(execution.id, {
		startedAt: new Date().toISOString()
	});

	const log = async (message: string) => {
		console.log(`[Event Cleanup] ${message}`);
		await appendScheduleExecutionLog(execution.id, `[${new Date().toISOString()}] ${message}`);
	};

	try {
		const { deleteOldContainerEvents } = await import('../../db');
		const retentionDays = await getEventRetentionDays();

		await log(`Starting cleanup of events older than ${retentionDays} days`);

		const deleted = await deleteOldContainerEvents(retentionDays);

		await log(`Removed ${deleted} old container events`);
		await updateScheduleExecution(execution.id, {
			status: 'success',
			completedAt: new Date().toISOString(),
			duration: Date.now() - startTime,
			details: { deletedCount: deleted, retentionDays }
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

/**
 * Execute volume helper cleanup job.
 * Cleans up stale dockhand-browse-* containers used for volume browsing.
 * @param triggeredBy - What triggered this execution
 * @param cleanupFns - Optional cleanup functions (passed from scheduler to avoid dynamic import issues)
 */
export async function runVolumeHelperCleanupJob(
	triggeredBy: ScheduleTrigger = 'cron',
	cleanupFns?: {
		cleanupStaleVolumeHelpers: () => Promise<void>;
		cleanupExpiredVolumeHelpers: () => Promise<void>;
	}
): Promise<void> {
	const startTime = Date.now();

	// Create execution record
	const execution = await createScheduleExecution({
		scheduleType: 'system_cleanup',
		scheduleId: SYSTEM_VOLUME_HELPER_CLEANUP_ID,
		environmentId: null,
		entityName: 'Volume helper cleanup',
		triggeredBy,
		status: 'running'
	});

	await updateScheduleExecution(execution.id, {
		startedAt: new Date().toISOString()
	});

	const log = async (message: string) => {
		console.log(`[Volume Helper Cleanup] ${message}`);
		await appendScheduleExecutionLog(execution.id, `[${new Date().toISOString()}] ${message}`);
	};

	try {
		await log('Starting cleanup of stale and expired volume helper containers');

		if (cleanupFns) {
			// Use provided functions (from scheduler static imports)
			await cleanupFns.cleanupStaleVolumeHelpers();
			await cleanupFns.cleanupExpiredVolumeHelpers();
		} else {
			// Fallback to dynamic import (may not work in production)
			const { runVolumeHelperCleanup } = await import('../../db');
			await runVolumeHelperCleanup();
		}

		await log('Cleanup completed successfully');
		await updateScheduleExecution(execution.id, {
			status: 'success',
			completedAt: new Date().toISOString(),
			duration: Date.now() - startTime
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

/**
 * Execute scanner cache cleanup job.
 * Removes scanner database volumes and bind mount directories to reclaim disk space.
 */
export async function runScannerCacheCleanupJob(
	triggeredBy: ScheduleTrigger = 'cron',
	cleanupFn?: () => Promise<{ volumes: string[]; dirs: string[] }>
): Promise<void> {
	// Check if cleanup is enabled (skip check if manually triggered)
	if (triggeredBy === 'cron') {
		const enabled = await getScannerCleanupEnabled();
		if (!enabled) {
			return; // Skip execution if disabled
		}
	}

	const startTime = Date.now();

	const execution = await createScheduleExecution({
		scheduleType: 'system_cleanup',
		scheduleId: SYSTEM_SCANNER_CLEANUP_ID,
		environmentId: null,
		entityName: 'Scanner cache cleanup',
		triggeredBy,
		status: 'running'
	});

	await updateScheduleExecution(execution.id, {
		startedAt: new Date().toISOString()
	});

	const log = async (message: string) => {
		console.log(`[Scanner Cache Cleanup] ${message}`);
		await appendScheduleExecutionLog(execution.id, `[${new Date().toISOString()}] ${message}`);
	};

	try {
		await log('Starting scanner cache cleanup');

		let result: { volumes: string[]; dirs: string[] };
		if (cleanupFn) {
			result = await cleanupFn();
		} else {
			const { cleanupScannerCache } = await import('../../scanner');
			result = await cleanupScannerCache();
		}

		if (result.volumes.length > 0) {
			await log(`Removed volumes: ${result.volumes.join(', ')}`);
		}
		if (result.dirs.length > 0) {
			await log(`Removed directories: ${result.dirs.join(', ')}`);
		}
		await log(`Cleanup complete: ${result.volumes.length} volumes, ${result.dirs.length} directories removed`);
		await updateScheduleExecution(execution.id, {
			status: 'success',
			completedAt: new Date().toISOString(),
			duration: Date.now() - startTime,
			details: { removedVolumes: result.volumes, removedDirs: result.dirs }
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
