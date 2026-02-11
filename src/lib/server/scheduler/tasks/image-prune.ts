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
		// Count unique images by filtering Untagged entries that are not digest references
		// Docker returns multiple entries per image: Untagged (tag), Untagged (digest @sha256:), Deleted (layers)
		// We only count tag-based Untagged entries to get actual image count
		const imagesRemoved = result?.ImagesDeleted
			?.filter((img: any) => img.Untagged && !img.Untagged.includes('@sha256:'))
			.length || 0;

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

		// Send success notification
		await sendEventNotification('image_prune_success', {
			title: 'Image prune completed',
			message: `${imagesRemoved} unused images removed, ${formatBytes(spaceReclaimed)} disk space reclaimed`,
			type: 'success'
		}, envId);

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
