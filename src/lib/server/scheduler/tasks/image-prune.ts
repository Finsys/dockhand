/**
 * Image Prune Task
 *
 * Handles scheduled pruning of unused Docker images per environment.
 */

import type { ScheduleTrigger, ImagePruneSettings } from '../../db';
import {
	getImagePruneSettings,
	setImagePruneSettings,
	getEnvironment,
	createScheduleExecution,
	updateScheduleExecution,
	appendScheduleExecutionLog
} from '../../db';
import { pruneImages } from '../../docker';
import { sendEventNotification } from '../../notifications';

/**
 * System job ID for image prune (starts at 100 to avoid conflicts with other system jobs)
 */
export const SYSTEM_IMAGE_PRUNE_BASE_ID = 100;

/**
 * Execute image prune for an environment.
 */
export async function runImagePrune(
	envId: number,
	triggeredBy: ScheduleTrigger
): Promise<void> {
	const startTime = Date.now();

	// Get environment info for logging
	const env = await getEnvironment(envId);
	if (!env) {
		console.error(`[Image Prune] Environment ${envId} not found`);
		return;
	}

	// Get prune settings
	const settings = await getImagePruneSettings(envId);
	if (!settings) {
		console.error(`[Image Prune] No settings found for environment ${envId}`);
		return;
	}

	// Create execution record
	const execution = await createScheduleExecution({
		scheduleType: 'image_prune',
		scheduleId: envId,
		environmentId: envId,
		entityName: `Image prune: ${env.name}`,
		triggeredBy,
		status: 'running'
	});

	await updateScheduleExecution(execution.id, {
		startedAt: new Date().toISOString()
	});

	const log = async (message: string) => {
		console.log(`[Image Prune] [${env.name}] ${message}`);
		await appendScheduleExecutionLog(execution.id, `[${new Date().toISOString()}] ${message}`);
	};

	try {
		const pruneMode = settings.pruneMode || 'dangling';
		const dangling = pruneMode === 'dangling';

		await log(`Starting image prune (mode: ${pruneMode})`);

		// Execute prune
		const result = await pruneImages(dangling, envId);

		// Extract space reclaimed and images removed from result
		const spaceReclaimed = result?.SpaceReclaimed || 0;
		// Count unique images removed.
		// Docker returns: Untagged (tag), Untagged (digest @sha256:), Deleted (layer sha256:)
		// For tagged images: count Untagged entries that are NOT digest references (tag-based)
		// For dangling images: there are no tag-based entries, only digest-based Untagged entries
		// So count tag-based Untagged first, fall back to digest-based Untagged for dangling prune
		const deleted = result?.ImagesDeleted || [];
		const tagEntries = deleted.filter((img: any) => img.Untagged && !img.Untagged.includes('@sha256:'));
		const digestEntries = deleted.filter((img: any) => img.Untagged && img.Untagged.includes('@sha256:'));
		const imagesRemoved = tagEntries.length > 0
			? tagEntries.length
			: digestEntries.length;

		// Format space for human-readable output
		const formatBytes = (bytes: number): string => {
			if (bytes === 0) return '0 B';
			const k = 1024;
			const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
			const i = Math.floor(Math.log(bytes) / Math.log(k));
			return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
		};

		await log(`Prune completed: ${imagesRemoved} images removed, ${formatBytes(spaceReclaimed)} reclaimed`);

		// Update settings with last prune info
		const updatedSettings: ImagePruneSettings = {
			...settings,
			lastPruned: new Date().toISOString(),
			lastResult: {
				spaceReclaimed,
				imagesRemoved
			}
		};
		await setImagePruneSettings(envId, updatedSettings);

		// Update execution record
		await updateScheduleExecution(execution.id, {
			status: 'success',
			completedAt: new Date().toISOString(),
			duration: Date.now() - startTime,
			details: {
				pruneMode,
				spaceReclaimed,
				imagesRemoved,
				deletedImages: result?.ImagesDeleted?.map((img: any) => img.Deleted || img.Untagged).filter(Boolean)
			}
		});

		// Send success notification only when something was actually cleaned up
		if (imagesRemoved > 0) {
			await sendEventNotification('image_prune_success', {
				title: 'Image prune completed',
				message: `${imagesRemoved} unused images removed, ${formatBytes(spaceReclaimed)} disk space reclaimed`,
				type: 'success'
			}, envId);
		}

	} catch (error: any) {
		await log(`Error: ${error.message}`);

		await updateScheduleExecution(execution.id, {
			status: 'failed',
			completedAt: new Date().toISOString(),
			duration: Date.now() - startTime,
			errorMessage: error.message
		});

		// Send failure notification
		await sendEventNotification('image_prune_failed', {
			title: 'Image prune failed',
			message: `Failed to prune images: ${error.message}`,
			type: 'error'
		}, envId);
	}
}
