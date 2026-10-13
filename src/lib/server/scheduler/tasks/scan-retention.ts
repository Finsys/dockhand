/**
 * Scan retention.
 *
 * Every vulnerability scan stores its whole findings document, and scans are
 * append-only, so a host that scans nightly accumulates gigabytes of results
 * that nothing reads. This keeps the current state of each image plus enough
 * history for the scan export, and drops what belongs to images the host no
 * longer has.
 *
 * The image list comes from the live daemons, so an environment that does not
 * answer contributes nothing and its scans are left untouched.
 */

import type { ScheduleTrigger } from '../../db';
import {
	listScanRecords,
	deleteScans,
	getEnvironments,
	createScheduleExecution,
	updateScheduleExecution,
	appendScheduleExecutionLog,
	getScanRetentionEnabled,
	getScanRetentionKeep,
	getScanRetentionGraceDays
} from '../../db';
import { listImages, DockerConnectionError, EnvironmentNotFoundError } from '../../docker';
import { answerIsUsable, planRetention } from '../../scan-retention-core';
import { invalidateVulnerabilitiesCache } from '../../vulnerabilities-cache';

export const SYSTEM_SCAN_RETENTION_ID = 5;

/**
 * Which environments gave a usable answer, and every image they hold.
 *
 * An environment counts only when it returned at least one image. A daemon can
 * answer with an empty list for reasons that have nothing to do with the scans -
 * a fresh store, a prune, a host still starting - and treating that as "none of
 * these images exist" would delete the environment's entire scan history on the
 * strength of a reply that says nothing.
 */
async function collectLiveImages(): Promise<{
	liveImageIds: Set<string>;
	reachableEnvIds: Set<number | null>;
	skipped: string[];
}> {
	const liveImageIds = new Set<string>();
	const reachableEnvIds = new Set<number | null>();
	const skipped: string[] = [];

	const environments = await getEnvironments();
	for (const env of environments) {
		try {
			const images = await listImages(env.id);
			if (!answerIsUsable(images)) {
				skipped.push(`${env.name} (reported no images)`);
				continue;
			}
			for (const image of images) liveImageIds.add(image.id);
			reachableEnvIds.add(env.id);
		} catch (error: unknown) {
			skipped.push(`${env.name} (did not answer)`);
			if (!(error instanceof DockerConnectionError) && !(error instanceof EnvironmentNotFoundError)) {
				console.error(`[Scan Retention] Error listing images for ${env.name}:`, error);
			}
		}
	}

	return { liveImageIds, reachableEnvIds, skipped };
}

export async function runScanRetentionJob(triggeredBy: ScheduleTrigger = 'cron'): Promise<void> {
	if (triggeredBy === 'cron' && !(await getScanRetentionEnabled())) return;

	const startTime = Date.now();
	const execution = await createScheduleExecution({
		scheduleType: 'system_cleanup',
		scheduleId: SYSTEM_SCAN_RETENTION_ID,
		environmentId: null,
		entityName: 'Vulnerability scan retention',
		triggeredBy,
		status: 'running'
	});

	await updateScheduleExecution(execution.id, { startedAt: new Date().toISOString() });

	const log = async (message: string) => {
		console.log(`[Scan Retention] ${message}`);
		await appendScheduleExecutionLog(execution.id, `[${new Date().toISOString()}] ${message}`);
	};

	try {
		const [keepPerImage, graceDays] = await Promise.all([
			getScanRetentionKeep(),
			getScanRetentionGraceDays()
		]);

		const { liveImageIds, reachableEnvIds, skipped } = await collectLiveImages();
		if (skipped.length > 0) {
			await log(`Leaving scans alone for: ${skipped.join(', ')}`);
		}

		const scans = await listScanRecords();
		const plan = planRetention(scans, liveImageIds, reachableEnvIds, new Date(), {
			keepPerImage,
			graceDays
		});

		await log(
			`${scans.length} scans, keeping ${keepPerImage} per image and scanner, ` +
			`${graceDays} day grace for removed images`
		);

		if (plan.deleteIds.length === 0) {
			await log('Nothing to remove');
		} else {
			await deleteScans(plan.deleteIds);
			// The dashboard caches findings; a delete makes that stale.
			invalidateVulnerabilitiesCache();
			await log(
				`Removed ${plan.deleteIds.length} scans: ${plan.supersededCount} superseded, ` +
				`${plan.goneImageCount} for images no longer present`
			);
		}

		await updateScheduleExecution(execution.id, {
			status: 'success',
			completedAt: new Date().toISOString(),
			duration: Date.now() - startTime,
			details: {
				deletedCount: plan.deleteIds.length,
				superseded: plan.supersededCount,
				goneImages: plan.goneImageCount,
				keepPerImage,
				graceDays
			}
		});
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		await log(`Error: ${message}`);
		await updateScheduleExecution(execution.id, {
			status: 'failed',
			completedAt: new Date().toISOString(),
			duration: Date.now() - startTime,
			errorMessage: message
		});
	}
}
