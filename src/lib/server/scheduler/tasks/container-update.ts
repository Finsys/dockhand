/**
 * Container Auto-Update Task
 *
 * Handles automatic container updates with vulnerability scanning.
 * Uses direct Docker API recreation with full Config/HostConfig passthrough
 * from inspect data. No compose commands for
 * individual container updates, no manual field mapping, zero settings loss.
 */

import type { ScheduleTrigger, VulnerabilityCriteria } from '../../db';
import {
	getAutoUpdateSettingById,
	updateAutoUpdateLastChecked,
	updateAutoUpdateLastUpdated,
	createScheduleExecution,
	updateScheduleExecution,
	appendScheduleExecutionLog,
	saveVulnerabilityScan
} from '../../db';
import {
	pullImage,
	listContainers,
	inspectContainer,
	stopContainer,
	startContainer,
	removeContainer,
	checkImageUpdateAvailable,
	getTempImageTag,
	isDigestBasedImage,
	getImageIdByTag,
	removeTempImage,
	tagImage,
	connectContainerToNetwork,
	disconnectContainerFromNetwork,
	recreateContainerFromInspect,
	inspectImage
} from '../../docker';
import type { ImageEnvLabels } from '../../container-env-merge';
import { getScannerSettings, scanImage, type ScanResult, type VulnerabilitySeverity } from '../../scanner';
import { sendEventNotification } from '../../notifications';
import { parseImageNameAndTag, combineScanSummaries, isSystemContainer, isPodmanInfraContainer } from './update-utils';
import { resolveBlockDecision } from './block-decision';
import { isUpdateDisabledByLabel, isHiddenByLabel } from '../../container-labels';

// =============================================================================
// TYPES
// =============================================================================

interface ScanContext {
	newImageId: string;
	currentImageId: string;
	envId: number | undefined;
	vulnerabilityCriteria: VulnerabilityCriteria;
	log: (msg: string) => void;
}

interface ScanOutcome {
	blocked: boolean;
	reason?: string;
	scanResults?: ScanResult[];
	scanSummary?: VulnerabilitySeverity;
}

interface ExecutionDetails {
	mode: string;
	newDigest?: string;
	vulnerabilityCriteria: VulnerabilityCriteria;
	reason?: string;
	blockReason?: string;
	summary: { checked: number; updated: number; blocked: number; failed: number };
	containers: Array<{
		name: string;
		status: string;
		blockReason?: string;
		scannerResults?: Array<{
			scanner: string;
			critical: number;
			high: number;
			medium: number;
			low: number;
			negligible: number;
			unknown: number;
		}>;
	}>;
	scanResult?: {
		summary: VulnerabilitySeverity;
		scanners: string[];
		scannedAt?: string;
		scannerResults: Array<{
			scanner: string;
			critical: number;
			high: number;
			medium: number;
			low: number;
			negligible: number;
			unknown: number;
		}>;
	};
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Scan an image and check if the update should be blocked based on vulnerability criteria.
 * Handles scanning, saving results, and comparing with current image for 'more_than_current'.
 */
async function scanAndCheckBlock(ctx: ScanContext): Promise<ScanOutcome> {
	const { newImageId, currentImageId, envId, vulnerabilityCriteria, log } = ctx;

	log(`Scanning new image for vulnerabilities...`);

	const scanResults = await scanImage(newImageId, envId, (progress) => {
		const scannerTag = progress.scanner ? `[${progress.scanner}]` : '[scan]';
		if (progress.message) {
			log(`${scannerTag} ${progress.message}`);
		}
		if (progress.output) {
			log(`${scannerTag} ${progress.output}`);
		}
	});

	if (scanResults.length === 0) {
		return { blocked: false, scanResults };
	}

	const scanSummary = combineScanSummaries(scanResults);
	log(`Scan result: ${scanSummary.critical} critical, ${scanSummary.high} high, ${scanSummary.medium} medium, ${scanSummary.low} low`);

	// Save scan results
	for (const result of scanResults) {
		try {
			await saveVulnerabilityScan({
				environmentId: envId ?? null,
				imageId: newImageId,
				imageName: result.imageName,
				scanner: result.scanner,
				scannedAt: result.scannedAt,
				scanDuration: result.scanDuration,
				criticalCount: result.summary.critical,
				highCount: result.summary.high,
				mediumCount: result.summary.medium,
				lowCount: result.summary.low,
				negligibleCount: result.summary.negligible,
				unknownCount: result.summary.unknown,
				vulnerabilities: result.vulnerabilities,
				error: result.error ?? null
			});
		} catch (saveError: any) {
			log(`Warning: Could not save scan results: ${saveError.message}`);
		}
	}

	// Decide whether to block. For 'more_than_current' this re-scans the current
	// image so the comparison uses up-to-date numbers (#1022) and works on a
	// cold cache.
	const { blocked, reason } = await resolveBlockDecision(
		scanSummary,
		currentImageId,
		envId,
		vulnerabilityCriteria,
		log
	);

	if (blocked) {
		log(`UPDATE BLOCKED: ${reason}`);
		return { blocked: true, reason, scanResults, scanSummary };
	}

	log(`Scan passed vulnerability criteria`);
	return { blocked: false, scanResults, scanSummary };
}

/**
 * Build scanner results array from scan results for execution details.
 */
function buildScannerResults(scanResults: ScanResult[]) {
	return scanResults.map(r => ({
		scanner: r.scanner,
		critical: r.summary.critical,
		high: r.summary.high,
		medium: r.summary.medium,
		low: r.summary.low,
		negligible: r.summary.negligible,
		unknown: r.summary.unknown
	}));
}

/**
 * Build execution details for a blocked update.
 */
function buildBlockedDetails(
	containerName: string,
	vulnerabilityCriteria: VulnerabilityCriteria,
	reason: string,
	scanResults: ScanResult[],
	scanSummary: VulnerabilitySeverity
): ExecutionDetails {
	const scannerResults = buildScannerResults(scanResults);
	return {
		mode: 'auto_update',
		reason: 'vulnerabilities_found',
		blockReason: reason,
		vulnerabilityCriteria,
		summary: { checked: 1, updated: 0, blocked: 1, failed: 0 },
		containers: [{
			name: containerName,
			status: 'blocked',
			blockReason: reason,
			scannerResults
		}],
		scanResult: {
			summary: scanSummary,
			scanners: scanResults.map(r => r.scanner),
			scannedAt: scanResults[0]?.scannedAt,
			scannerResults
		}
	};
}

/**
 * Build execution details for a successful update.
 */
function buildSuccessDetails(
	containerName: string,
	newDigest: string | undefined,
	vulnerabilityCriteria: VulnerabilityCriteria,
	scanResults?: ScanResult[],
	scanSummary?: VulnerabilitySeverity
): ExecutionDetails {
	const scannerResults = scanResults ? buildScannerResults(scanResults) : undefined;
	return {
		mode: 'auto_update',
		newDigest,
		vulnerabilityCriteria,
		summary: { checked: 1, updated: 1, blocked: 0, failed: 0 },
		containers: [{
			name: containerName,
			status: 'updated',
			scannerResults
		}],
		scanResult: scanSummary ? {
			summary: scanSummary,
			scanners: scanResults?.map(r => r.scanner) || [],
			scannedAt: scanResults?.[0]?.scannedAt,
			scannerResults: scannerResults || []
		} : undefined
	};
}

// =============================================================================
// MAIN UPDATE FUNCTION
// =============================================================================

/**
 * Execute a container auto-update.
 */
export async function runContainerUpdate(
	settingId: number,
	containerName: string,
	environmentId: number | null | undefined,
	triggeredBy: ScheduleTrigger
): Promise<void> {
	const envId = environmentId ?? undefined;
	const startTime = Date.now();

	// Create execution record
	const execution = await createScheduleExecution({
		scheduleType: 'container_update',
		scheduleId: settingId,
		environmentId: environmentId ?? null,
		entityName: containerName,
		triggeredBy,
		status: 'running'
	});

	await updateScheduleExecution(execution.id, {
		startedAt: new Date().toISOString()
	});

	const log = (message: string) => {
		console.log(`[Auto-update] ${message}`);
		appendScheduleExecutionLog(execution.id, `[${new Date().toISOString()}] ${message}`);
	};

	try {
		log(`Checking container: ${containerName}`);
		await updateAutoUpdateLastChecked(containerName, envId);

		// Find the container
		const containers = await listContainers(true, envId);
		const container = containers.find(c => c.name === containerName);

		if (!container) {
			log(`Container not found: ${containerName}`);
			await updateScheduleExecution(execution.id, {
				status: 'failed',
				completedAt: new Date().toISOString(),
				duration: Date.now() - startTime,
				errorMessage: 'Container not found'
			});
			return;
		}

		// Podman pod-infra containers (#1221): silently skip before any inspect /
		// image-resolution that would fail with "Could not determine image name".
		if (isPodmanInfraContainer(containerName)) {
			log(`Skipping Podman pod-infra container`);
			await updateScheduleExecution(execution.id, {
				status: 'skipped',
				completedAt: new Date().toISOString(),
				duration: Date.now() - startTime,
				details: { reason: 'Podman pod-infra container' }
			});
			return;
		}

		// Get the full container config to extract the image name (tag)
		const inspectData = await inspectContainer(container.id, envId) as any;
		const imageNameFromConfig = inspectData.Config?.Image;

		if (!imageNameFromConfig) {
			log(`Could not determine image name from container config`);
			await updateScheduleExecution(execution.id, {
				status: 'failed',
				completedAt: new Date().toISOString(),
				duration: Date.now() - startTime,
				errorMessage: 'Could not determine image name'
			});
			return;
		}

		// Prevent system containers (Dockhand/Hawser) from being updated
		const systemContainerType = isSystemContainer(imageNameFromConfig);
		if (systemContainerType) {
			const reason = systemContainerType === 'dockhand'
				? 'Cannot auto-update Dockhand itself'
				: 'Cannot auto-update Hawser agent';
			log(`Skipping ${systemContainerType} container - ${reason}`);
			await updateScheduleExecution(execution.id, {
				status: 'skipped',
				completedAt: new Date().toISOString(),
				duration: Date.now() - startTime,
				details: { reason }
			});
			return;
		}

		// Check dockhand.update label (label wins over DB settings)
		if (isUpdateDisabledByLabel(inspectData.Config?.Labels)) {
			log(`Skipping - dockhand.update=false label set on container`);
			await updateScheduleExecution(execution.id, {
				status: 'skipped',
				completedAt: new Date().toISOString(),
				duration: Date.now() - startTime,
				details: { reason: 'Skipped by dockhand.update=false label' }
			});
			return;
		}

		// Hidden containers are excluded from update polling and auto-updates (#1083)
		if (isHiddenByLabel(inspectData.Config?.Labels)) {
			log(`Skipping - dockhand.hidden=true label set on container`);
			await updateScheduleExecution(execution.id, {
				status: 'skipped',
				completedAt: new Date().toISOString(),
				duration: Date.now() - startTime,
				details: { reason: 'Skipped by dockhand.hidden=true label' }
			});
			return;
		}

		// Skip digest-pinned images - they are explicitly locked to a specific version
		if (isDigestBasedImage(imageNameFromConfig)) {
			log(`Skipping ${containerName} - image pinned to specific digest`);
			await updateScheduleExecution(execution.id, {
				status: 'skipped',
				completedAt: new Date().toISOString(),
				duration: Date.now() - startTime,
				details: { reason: 'Image pinned to specific digest' }
			});
			return;
		}

		// Get the actual image ID from inspect data
		const currentImageId = inspectData.Image;

		// Capture the OLD image's Env/Labels/Cmd/Entrypoint BEFORE the pull — the old digest may
		// be untagged/GC'd afterward. Forwarded to the env/label/command rebase (#1226, #1256, #1371).
		let oldImageConfig: ImageEnvLabels | null = null;
		try {
			const oldImg = await inspectImage(currentImageId, envId) as any;
			oldImageConfig = { Env: oldImg?.Config?.Env, Labels: oldImg?.Config?.Labels, Cmd: oldImg?.Config?.Cmd ?? null, Entrypoint: oldImg?.Config?.Entrypoint ?? null };
		} catch {
			// Best-effort; rebase falls back if unavailable.
		}

		log(`Container is using image: ${imageNameFromConfig}`);
		log(`Current image ID: ${currentImageId?.substring(0, 19)}`);

		// Get scanner and schedule settings early to determine scan strategy
		const [scannerSettings, updateSetting] = await Promise.all([
			getScannerSettings(envId),
			getAutoUpdateSettingById(settingId)
		]);

		const vulnerabilityCriteria = (updateSetting?.vulnerabilityCriteria || 'never') as VulnerabilityCriteria;
		const shouldScan = scannerSettings.scanner !== 'none';

		// =============================================================================
		// CHECK FOR UPDATES
		// =============================================================================

		log(`Checking registry for updates: ${imageNameFromConfig}`);
		const registryCheck = await checkImageUpdateAvailable(imageNameFromConfig, currentImageId, envId);

		if (registryCheck.isLocalImage) {
			log(`Local image detected - skipping (auto-update requires registry)`);
			await updateScheduleExecution(execution.id, {
				status: 'skipped',
				completedAt: new Date().toISOString(),
				duration: Date.now() - startTime,
				details: { reason: 'Local image - no registry available' }
			});
			return;
		}

		if (registryCheck.error) {
			log(`Registry check error: ${registryCheck.error}`);
			await updateScheduleExecution(execution.id, {
				status: 'skipped',
				completedAt: new Date().toISOString(),
				duration: Date.now() - startTime,
				details: { reason: `Registry check failed: ${registryCheck.error}` }
			});
			return;
		}

		if (!registryCheck.hasUpdate) {
			log(`Already up-to-date: ${containerName} is running the latest version`);
			await updateScheduleExecution(execution.id, {
				status: 'skipped',
				completedAt: new Date().toISOString(),
				duration: Date.now() - startTime,
				details: { reason: 'Already up-to-date' }
			});
			return;
		}

		log(`Update available! Registry digest: ${registryCheck.registryDigest?.substring(0, 19) || 'unknown'}`);
		const newDigest = registryCheck.registryDigest;

		// =============================================================================
		// PULL & SCAN: Temp-tag protection flow
		// =============================================================================
		// 1. Pull new image (overwrites tag)
		// 2. Restore original tag to OLD image (safety)
		// 3. Tag new image with temp suffix
		// 4. Scan temp image, block if needed
		// 5. Re-tag to original, recreate container
		// =============================================================================

		let newImageId: string | null = null;
		let scanOutcome: ScanOutcome = { blocked: false };

		if (shouldScan && !isDigestBasedImage(imageNameFromConfig)) {
			const tempTag = getTempImageTag(imageNameFromConfig);
			log(`Using temp tag for safe pull: ${tempTag}`);

			try {
				// Pull new image
				log(`Pulling new image: ${imageNameFromConfig}`);
				await pullImage(imageNameFromConfig, undefined, envId);

				// Get new image ID
				newImageId = await getImageIdByTag(imageNameFromConfig, envId);
				if (!newImageId) {
					throw new Error('Failed to get new image ID after pull');
				}
				log(`New image pulled: ${newImageId.substring(0, 19)}`);

				// Restore original tag to OLD image for safety
				log(`Restoring original tag to safe image...`);
				const [oldRepo, oldTag] = parseImageNameAndTag(imageNameFromConfig);
				await tagImage(currentImageId, oldRepo, oldTag, envId);

				// Tag new image with temp suffix
				const [tempRepo, tempTagName] = parseImageNameAndTag(tempTag);
				await tagImage(newImageId, tempRepo, tempTagName, envId);
				log(`New image tagged as: ${tempTag}`);

				// Scan new image (by ID, not temp tag - for proper cache storage)
				try {
					scanOutcome = await scanAndCheckBlock({
						newImageId,
						currentImageId,
						envId,
						vulnerabilityCriteria,
						log
					});

					if (scanOutcome.blocked) {
						log(`Removing blocked image: ${tempTag}`);
						await removeTempImage(newImageId, envId);

						await updateScheduleExecution(execution.id, {
							status: 'skipped',
							completedAt: new Date().toISOString(),
							duration: Date.now() - startTime,
							details: buildBlockedDetails(
								containerName,
								vulnerabilityCriteria,
								scanOutcome.reason!,
								scanOutcome.scanResults!,
								scanOutcome.scanSummary!
							)
						});

						await sendEventNotification('auto_update_blocked', {
							title: 'Auto-update blocked',
							message: `Container "${containerName}" update blocked: ${scanOutcome.reason}`,
							type: 'warning'
						}, envId);

						return;
					}
				} catch (scanError: any) {
					log(`Scan failed: ${scanError.message}`);
					log(`Removing temp image...`);
					await removeTempImage(newImageId, envId);

					await updateScheduleExecution(execution.id, {
						status: 'failed',
						completedAt: new Date().toISOString(),
						duration: Date.now() - startTime,
						errorMessage: `Vulnerability scan failed: ${scanError.message}`
					});
					return;
				}

				// Re-tag approved image to original
				log(`Re-tagging approved image to: ${imageNameFromConfig}`);
				await tagImage(newImageId, oldRepo, oldTag, envId);

				// Clean up temp tag
				try {
					await removeTempImage(tempTag, envId);
				} catch { /* ignore */ }

			} catch (pullError: any) {
				log(`Pull failed: ${pullError.message}`);
				await updateScheduleExecution(execution.id, {
					status: 'failed',
					completedAt: new Date().toISOString(),
					duration: Date.now() - startTime,
					errorMessage: `Failed to pull image: ${pullError.message}`
				});
				return;
			}
		} else {
			// No scanning - simple pull
			log(`Pulling update (no vulnerability scan)...`);
			try {
				await pullImage(imageNameFromConfig, undefined, envId);
				log(`Image pulled successfully`);
			} catch (pullError: any) {
				log(`Pull failed: ${pullError.message}`);
				await updateScheduleExecution(execution.id, {
					status: 'failed',
					completedAt: new Date().toISOString(),
					duration: Date.now() - startTime,
					errorMessage: `Failed to pull image: ${pullError.message}`
				});
				return;
			}
		}

		// =============================================================================
		// RECREATE CONTAINER (full config passthrough from inspect data)
		// =============================================================================

		log(`Recreating container with full config passthrough...`);
		const result = await recreateContainer(containerName, envId, {
			log,
			imageNameOverride: imageNameFromConfig,
			oldImageConfig
		});

		if (result.success) {
			await updateAutoUpdateLastUpdated(containerName, envId);
			log(`Successfully updated container: ${containerName}`);

			await updateScheduleExecution(execution.id, {
				status: 'success',
				completedAt: new Date().toISOString(),
				duration: Date.now() - startTime,
				details: buildSuccessDetails(
					containerName,
					newDigest,
					vulnerabilityCriteria,
					scanOutcome.scanResults,
					scanOutcome.scanSummary
				)
			});

			await sendEventNotification('auto_update_success', {
				title: 'Container auto-updated',
				message: `Container "${containerName}" was updated to a new image version`,
				type: 'success'
			}, envId);
		} else {
			throw new Error(result.error || 'Failed to recreate container');
		}

	} catch (error: any) {
		log(`Error: ${error.message}`);
		await updateScheduleExecution(execution.id, {
			status: 'failed',
			completedAt: new Date().toISOString(),
			duration: Date.now() - startTime,
			errorMessage: error.message
		});

		await sendEventNotification('auto_update_failed', {
			title: 'Auto-update failed',
			message: `Container "${containerName}" auto-update failed: ${error.message}`,
			type: 'error'
		}, envId);
	}
}

// =============================================================================
// EXPORTED HELPER FUNCTIONS
// =============================================================================

/**
 * Recreate a container using full Config/HostConfig passthrough from inspect data.
 * Passes inspect data directly to Docker API create, only changing the image.
 * No manual field mapping — zero settings loss.
 */
export interface RecreateContainerOptions {
	/** Progress logger. */
	log?: (msg: string) => void;
	/** New image to recreate with (defaults to the container's current image). */
	imageNameOverride?: string;
	/**
	 * OLD image Config (Env/Labels) captured BEFORE the new image was pulled —
	 * forwarded to the env/label rebase (#1226, #1256), since the old image may
	 * no longer be inspectable after the pull repoints the tag.
	 */
	oldImageConfig?: ImageEnvLabels | null;
}

export async function recreateContainer(
	containerName: string,
	envId?: number,
	options: RecreateContainerOptions = {}
): Promise<{ success: boolean; error?: string }> {
	const { log, imageNameOverride, oldImageConfig } = options;
	try {
		const containers = await listContainers(true, envId);
		const container = containers.find(c => c.name === containerName);

		if (!container) {
			log?.(`Container not found: ${containerName}`);
			return { success: false, error: `Container not found: ${containerName}` };
		}

		const inspectData = await inspectContainer(container.id, envId) as any;
		const imageName = imageNameOverride || inspectData.Config?.Image;
		// Capture the parent's id BEFORE recreate. A recreate gives the parent a NEW id,
		// and any child using `network_mode: service:parent` / `container:parent` stores
		// that old id in its own HostConfig.NetworkMode (`container:<oldId>`). After the
		// parent update those children still point at the dead id and fail to (re)start
		// with "joining network namespace of container: No such container" (#570).
		const oldParentId: string = inspectData.Id;

		log?.(`Recreating container: ${containerName} (image: ${imageName})`);

		await recreateContainerFromInspect(inspectData, imageName, envId, log, oldImageConfig);

		// Parent recreate SUCCEEDED (a failure would have thrown and rolled the parent
		// back to its original id, leaving children valid). Repoint any dependent
		// children at the new parent. Best-effort and fully isolated: a child failure
		// NEVER changes the parent's already-successful update. No-op when there are no
		// such children — the common case pays nothing beyond one already-in-hand id.
		try {
			const reconnected = await reconnectDependentChildren(oldParentId, containerName, envId, log);
			if (reconnected > 0) {
				log?.(`Reconnected ${reconnected} dependent container${reconnected === 1 ? '' : 's'} to the new parent`);
			}
		} catch (e: any) {
			log?.(`WARNING: dependent-child reconnect step errored (parent update stands): ${e?.message}`);
		}

		// recreateContainer is only ever called to UPDATE a container's image (scheduled
		// auto-update AND the manual batch-update UI), so a successful recreate is a
		// container_updated event. This is what the UI's "container updated" toggle
		// promises; auto_update_success is raised separately by the scheduler path. (#1424)
		try {
			await sendEventNotification('container_updated', {
				title: 'Container updated',
				message: `Container "${containerName}" was updated to a new image (${imageName})`,
				type: 'success'
			}, envId);
		} catch (e: any) {
			log?.(`WARNING: container_updated notification failed (update stands): ${e?.message}`);
		}

		return { success: true };
	} catch (error: any) {
		log?.(`Failed to recreate container: ${error.message}`);
		return { success: false, error: error.message };
	}
}

/**
 * After a parent container is recreated (new id), find containers whose network is
 * shared into the parent by id (`network_mode: service:X`/`container:X`, which Docker
 * lowers to `HostConfig.NetworkMode = "container:<parentId>"`) and repoint them at the
 * new parent. A plain restart is NOT enough — the stale id is baked into the child's
 * stored NetworkMode, so the child must be RECREATED with the reference rewritten. We
 * rewrite to `container:<parentName>` (not the new id) so the child also survives future
 * parent recreations. Best-effort per child; the caller isolates this from the parent
 * update result. Returns the number of children repointed. (#570)
 */
async function reconnectDependentChildren(
	oldParentId: string,
	newParentName: string,
	envId: number | undefined,
	log?: (msg: string) => void,
	visited: Set<string> = new Set()
): Promise<number> {
	if (visited.has(oldParentId)) return 0; // cycle guard for A<-B<-C chains
	visited.add(oldParentId);

	const all = await listContainers(true, envId); // include stopped
	let count = 0;
	for (const c of all) {
		if (c.id === oldParentId) continue;
		let ci: any;
		try { ci = await inspectContainer(c.id, envId); } catch { continue; }
		const mode: string = ci.HostConfig?.NetworkMode || '';
		if (!mode.startsWith('container:')) continue;
		const ref = mode.slice('container:'.length);
		// Match the parent by full id, or defensively by short (12-char) id.
		if (ref !== oldParentId && ref !== oldParentId.slice(0, 12) && !oldParentId.startsWith(ref)) continue;

		log?.(`Reconnecting dependent container "${c.name}" -> container:${newParentName}`);
		const oldChildId: string = ci.Id;
		ci.HostConfig.NetworkMode = `container:${newParentName}`;
		try {
			const { Id: newChildId } = await recreateContainerFromInspect(ci, ci.Config.Image, envId, log);
			count++;
			// Chain: if this child was itself a parent to others, repoint them too.
			if (newChildId && newChildId !== oldChildId) {
				count += await reconnectDependentChildren(oldChildId, c.name, envId, log, visited);
			}
		} catch (e: any) {
			log?.(`WARNING: failed to reconnect dependent "${c.name}": ${e?.message}`);
		}
	}
	return count;
}

