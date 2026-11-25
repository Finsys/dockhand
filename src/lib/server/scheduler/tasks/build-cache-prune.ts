/**
 * Build Cache Prune Task
 *
 * Handles scheduled pruning of Docker build cache per environment.
 */

import type { ScheduleTrigger, BuildCachePruneSettings } from '../../db';
import {
	getBuildCachePruneSettings,
	setBuildCachePruneSettings,
	getEnvironment,
	createScheduleExecution,
	updateScheduleExecution,
	appendScheduleExecutionLog
} from '../../db';
import { pruneBuildCache } from '../../docker';
import { invalidateDiskUsage } from '../../disk-usage-cache';
import { sendEventNotification } from '../../notifications';

/**
 * System job ID for build cache prune (offset from the other system jobs:
 * image prune uses 100).
 */
export const SYSTEM_BUILD_CACHE_PRUNE_BASE_ID = 110;

function formatBytes(bytes: number): string {
	if (bytes === 0) return '0 B';
	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Execute build cache prune for an environment.
 */
export async function runBuildCachePrune(
	envId: number,
	triggeredBy: ScheduleTrigger
): Promise<void> {
	const startTime = Date.now();

	const env = await getEnvironment(envId);
	if (!env) {
		console.error(`[Build Cache Prune] Environment ${envId} not found`);
		return;
	}

	const settings = await getBuildCachePruneSettings(envId);
	if (!settings) {
		console.error(`[Build Cache Prune] No settings found for environment ${envId}`);
		return;
	}

	const execution = await createScheduleExecution({
		scheduleType: 'build_cache_prune',
		scheduleId: envId,
		environmentId: envId,
		entityName: `Build cache prune: ${env.name}`,
		triggeredBy,
		status: 'running'
	});

	await updateScheduleExecution(execution.id, {
		startedAt: new Date().toISOString()
	});

	const log = async (message: string) => {
		console.log(`[Build Cache Prune] [${env.name}] ${message}`);
		await appendScheduleExecutionLog(execution.id, `[${new Date().toISOString()}] ${message}`);
	};

	try {
		const pruneMode = settings.pruneMode || 'dangling';
		const all = pruneMode === 'all';

		await log(`Starting build cache prune (mode: ${pruneMode}, env id ${envId})`);

		// A prune that fails part way may still have freed space.
		const result = await pruneBuildCache(
			{ all, until: settings.until, reservedSpace: settings.reservedSpace },
			envId
		).finally(() => invalidateDiskUsage(envId));

		const spaceReclaimed: number | undefined = result?.SpaceReclaimed;
		const cachesDeleted = result?.CachesDeleted?.length ?? 0;

		const reclaimed = spaceReclaimed === undefined ? '' : `, ${formatBytes(spaceReclaimed)} reclaimed`;
		await log(`Prune completed: ${cachesDeleted} cache records removed${reclaimed}`);

		const updatedSettings: BuildCachePruneSettings = {
			...settings,
			lastPruned: new Date().toISOString(),
			lastResult: {
				spaceReclaimed,
				cachesDeleted
			}
		};
		await setBuildCachePruneSettings(envId, updatedSettings);

		await updateScheduleExecution(execution.id, {
			status: 'success',
			completedAt: new Date().toISOString(),
			duration: Date.now() - startTime,
			details: {
				pruneMode,
				spaceReclaimed,
				cachesDeleted
			}
		});

		// Notify only when something was actually reclaimed.
		if (spaceReclaimed !== undefined && spaceReclaimed > 0) {
			await sendEventNotification('build_cache_prune_success', {
				title: `Build cache prune completed — ${env.name}`,
				message: `${formatBytes(spaceReclaimed)} of build cache reclaimed (${cachesDeleted} records)`,
				type: 'success'
			}, envId);
		}

	} catch (error: any) {
		await log(`Error: ${error.message}${error.statusCode ? ` (HTTP ${error.statusCode})` : ''}`);

		await updateScheduleExecution(execution.id, {
			status: 'failed',
			completedAt: new Date().toISOString(),
			duration: Date.now() - startTime,
			errorMessage: error.message
		});

		await sendEventNotification('build_cache_prune_failed', {
			title: `Build cache prune failed — ${env.name}`,
			message: `Failed to prune build cache: ${error.message}`,
			type: 'error'
		}, envId);
	}
}
