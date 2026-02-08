/**
 * Container Auto-Update Task
 *
 * Handles automatic container updates with vulnerability scanning.
 *
 * For containers that are part of a Docker Compose stack, updates use
 * `docker compose up -d` to preserve ALL configuration from the compose file
 * (network aliases, static IPs, health checks, resource limits, etc.).
 *
 * For standalone containers, updates use container recreation with comprehensive
 * settings preservation.
 */

import type { ScheduleTrigger, VulnerabilityCriteria } from '../../db';
import {
	getAutoUpdateSettingById,
	updateAutoUpdateLastChecked,
	updateAutoUpdateLastUpdated,
	createScheduleExecution,
	updateScheduleExecution,
	appendScheduleExecutionLog,
	saveVulnerabilityScan,
	getCombinedScanForImage
} from '../../db';
import {
	pullImage,
	listContainers,
	inspectContainer,
	createContainer,
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
	extractContainerOptions
} from '../../docker';
import { getScannerSettings, scanImage, type ScanResult, type VulnerabilitySeverity } from '../../scanner';
import { sendEventNotification } from '../../notifications';
import { parseImageNameAndTag, shouldBlockUpdate, combineScanSummaries, isSystemContainer } from './update-utils';
import { getStackComposeFile, updateStackService, pullStackService } from '../../stacks';

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

	// Handle 'more_than_current' criteria - need to get/scan current image
	let currentScanSummary: VulnerabilitySeverity | undefined;
	if (vulnerabilityCriteria === 'more_than_current') {
		log(`Looking up cached scan for current image...`);
		try {
			const cachedScan = await getCombinedScanForImage(currentImageId, envId ?? null);
			if (cachedScan) {
				currentScanSummary = cachedScan;
				log(`Cached scan: ${currentScanSummary.critical} critical, ${currentScanSummary.high} high`);
			} else {
				log(`No cached scan found, scanning current image...`);
				const currentScanResults = await scanImage(currentImageId, envId, (progress) => {
					const tag = progress.scanner ? `[${progress.scanner}]` : '[scan]';
					if (progress.message) log(`${tag} ${progress.message}`);
				});
				if (currentScanResults.length > 0) {
					currentScanSummary = combineScanSummaries(currentScanResults);
					log(`Current image: ${currentScanSummary.critical} critical, ${currentScanSummary.high} high`);
					// Save for future use
					for (const result of currentScanResults) {
						try {
							await saveVulnerabilityScan({
								environmentId: envId ?? null,
								imageId: currentImageId,
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
						} catch { /* ignore */ }
					}
				}
			}
		} catch (cacheError: any) {
			log(`Warning: Could not get current scan: ${cacheError.message}`);
		}
	}

	// Check if update should be blocked
	const { blocked, reason } = shouldBlockUpdate(vulnerabilityCriteria, scanSummary, currentScanSummary);

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

		log(`Container is using image: ${imageNameFromConfig}`);
		log(`Current image ID: ${currentImageId?.substring(0, 19)}`);

		// Detect if container is part of a Docker Compose stack
		const containerLabels = inspectData.Config?.Labels || {};
		const composeProject = containerLabels['com.docker.compose.project'];
		const composeService = containerLabels['com.docker.compose.service'];
		const composeConfigFiles = containerLabels['com.docker.compose.project.config_files'];
		const isStackContainer = !!(composeProject && composeService);

		if (isStackContainer) {
			log(`Container is part of compose stack: ${composeProject} (service: ${composeService}, configFiles: ${composeConfigFiles || 'none'})`);
		} else {
			log(`Container is standalone (not part of a compose stack)`);
		}

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
		// STACK CONTAINER: Compose-native flow
		// =============================================================================
		// 1. Check if we have the compose file
		// 2. docker compose pull <service>
		// 3. Scan if enabled, block if needed
		// 4. docker compose up -d <service>
		// =============================================================================

		if (isStackContainer) {
			const composeResult = await getStackComposeFile(composeProject, envId, composeConfigFiles);
			log(`Compose lookup result: success=${composeResult.success}, composePath=${composeResult.composePath || 'none'}`);

			if (composeResult.success) {
				log(`Using compose-native update for stack: ${composeProject}`);

				try {
					// Pull via docker compose
					log(`Running: docker compose pull ${composeService}`);
					const pullResult = await pullStackService(composeProject, composeService, envId, composeConfigFiles);
					if (!pullResult.success) {
						throw new Error(pullResult.error || 'docker compose pull failed');
					}
					log(`Compose pull completed`);

					// Get new image ID
					const newImageId = await getImageIdByTag(imageNameFromConfig, envId);
					if (!newImageId) {
						throw new Error('Failed to get new image ID after compose pull');
					}
					log(`New image ID: ${newImageId.substring(0, 19)}`);

					// Scan if enabled
					let scanOutcome: ScanOutcome = { blocked: false };
					if (shouldScan) {
						try {
							scanOutcome = await scanAndCheckBlock({
								newImageId,
								currentImageId,
								envId,
								vulnerabilityCriteria,
								log
							});

							if (scanOutcome.blocked) {
								// Restore old tag so container keeps using safe image
								log(`Restoring original tag to safe image...`);
								const [oldRepo, oldTag] = parseImageNameAndTag(imageNameFromConfig);
								await tagImage(currentImageId, oldRepo, oldTag, envId);

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
							log(`Restoring original tag...`);
							const [oldRepo, oldTag] = parseImageNameAndTag(imageNameFromConfig);
							await tagImage(currentImageId, oldRepo, oldTag, envId);

							await updateScheduleExecution(execution.id, {
								status: 'failed',
								completedAt: new Date().toISOString(),
								duration: Date.now() - startTime,
								errorMessage: `Vulnerability scan failed: ${scanError.message}`
							});
							return;
						}
					}

					// Apply update via docker compose up
					log(`Running: docker compose up -d ${composeService}`);
					const upResult = await updateStackService(composeProject, composeService, envId, composeConfigFiles);
					if (!upResult.success) {
						throw new Error(upResult.error || 'docker compose up failed');
					}

					// Success
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

					return;

				} catch (composeError: any) {
					log(`Compose update failed: ${composeError.message}`);
					await updateScheduleExecution(execution.id, {
						status: 'failed',
						completedAt: new Date().toISOString(),
						duration: Date.now() - startTime,
						errorMessage: `Stack update failed: ${composeError.message}`
					});

					await sendEventNotification('auto_update_failed', {
						title: 'Auto-update failed',
						message: `Container "${containerName}" auto-update failed: ${composeError.message}`,
						type: 'error'
					}, envId);

					return;
				}
			}

			// No compose file found - fall through to standalone flow
			log(`No compose file found for stack "${composeProject}" - using standalone update`);
			log(`TIP: Import this stack into Dockhand for compose-native updates`);
		}

		// =============================================================================
		// STANDALONE CONTAINER: Temp-tag protection flow
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
		// RECREATE CONTAINER
		// =============================================================================

		if (isStackContainer) {
			log(`External stack - recreating container directly`);
			log(`WARNING: Some compose settings may not be preserved`);
		} else {
			log(`Recreating standalone container...`);
		}

		const success = await recreateContainer(containerName, envId, log);

		if (success) {
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
			throw new Error('Failed to recreate container');
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
 * Recreate a standalone container with comprehensive settings preservation.
 * Extracts and preserves 50+ container settings from the original container.
 */
export async function recreateContainer(
	containerName: string,
	envId?: number,
	log?: (msg: string) => void
): Promise<boolean> {
	try {
		const containers = await listContainers(true, envId);
		const container = containers.find(c => c.name === containerName);

		if (!container) {
			log?.(`Container not found: ${containerName}`);
			return false;
		}

		const inspectData = await inspectContainer(container.id, envId) as any;
		const wasRunning = inspectData.State.Running;
		const hostConfig = inspectData.HostConfig;
		const config = inspectData.Config;

		log?.(`Recreating container: ${containerName} (was running: ${wasRunning})`);
		log?.(`Preserving all container settings...`);

		if (wasRunning) {
			log?.('Stopping container...');
			await stopContainer(container.id, envId);
		}

		log?.('Removing old container...');
		await removeContainer(container.id, true, envId);

		const containerOptions = extractContainerOptions(inspectData);

		// Handle additional networks
		const networkSettings = inspectData.NetworkSettings?.Networks || {};
		const primaryNetwork = hostConfig.NetworkMode || 'bridge';
		const shortContainerId = container.id.substring(0, 12);
		const composeProject = config.Labels?.['com.docker.compose.project'];
		const composeService = config.Labels?.['com.docker.compose.service'];

		interface NetworkInfo {
			name: string;
			aliases: string[];
			ipv4Address: string | undefined;
			ipv6Address: string | undefined;
			gwPriority: number | undefined;
		}

		const additionalNetworks: NetworkInfo[] = [];

		for (const [netName, netConfig] of Object.entries(networkSettings)) {
			const netConf = netConfig as any;
			const isPrimary = netName === primaryNetwork ||
				(primaryNetwork === 'bridge' && (netName === 'bridge' || netName === 'default'));

			if (isPrimary) {
				if (containerOptions.networkAliases?.length) {
					log?.(`Primary network aliases: ${containerOptions.networkAliases.join(', ')}`);
				}
				if (containerOptions.networkIpv4Address) {
					log?.(`Primary network static IPv4: ${containerOptions.networkIpv4Address}`);
				}
			} else {
				const secondaryAliases = ((netConf.Aliases?.length > 0 ? netConf.Aliases : netConf.DNSNames) || [])
					.filter((a: string) => a !== container.id && a !== shortContainerId);

				if (composeProject && composeService) {
					if (!secondaryAliases.includes(composeService)) {
						secondaryAliases.push(composeService);
					}
					const projectService = `${composeProject}-${composeService}`;
					if (!secondaryAliases.includes(projectService)) {
						secondaryAliases.push(projectService);
					}
				}

				additionalNetworks.push({
					name: netName,
					aliases: secondaryAliases,
					ipv4Address: netConf.IPAMConfig?.IPv4Address || undefined,
					ipv6Address: netConf.IPAMConfig?.IPv6Address || undefined,
					gwPriority: netConf.GwPriority !== undefined && netConf.GwPriority !== 0
						? netConf.GwPriority : undefined
				});
			}
		}

		if (additionalNetworks.length > 0) {
			log?.(`Will reconnect to ${additionalNetworks.length} additional network(s)`);
		}

		log?.('Creating new container...');
		const newContainer = await createContainer(containerOptions, envId);

		for (const netInfo of additionalNetworks) {
			try {
				await connectContainerToNetwork(netInfo.name, newContainer.id, envId, {
					aliases: netInfo.aliases.length > 0 ? netInfo.aliases : undefined,
					ipv4Address: netInfo.ipv4Address,
					ipv6Address: netInfo.ipv6Address,
					gwPriority: netInfo.gwPriority
				});
				log?.(`  Connected to: ${netInfo.name}`);
			} catch (netError: any) {
				log?.(`  Warning: Failed to connect to "${netInfo.name}": ${netError.message}`);
			}
		}

		if (wasRunning) {
			log?.('Starting new container...');
			await newContainer.start();
		}

		log?.('Container recreated successfully');
		return true;
	} catch (error: any) {
		log?.(`Failed to recreate container: ${error.message}`);
		return false;
	}
}

/**
 * Update a container that is part of a Docker Compose stack.
 * Uses `docker compose up -d <service>` which preserves all compose configuration.
 *
 * @returns true if update succeeded, false if stack not found (use fallback)
 */
export async function updateStackContainer(
	stackName: string,
	serviceName: string,
	envId?: number,
	log?: (msg: string) => void,
	composeConfigPath?: string
): Promise<boolean> {
	try {
		log?.(`Looking up stack: ${stackName}`);

		const composeResult = await getStackComposeFile(stackName, envId, composeConfigPath);

		if (!composeResult.success || !composeResult.content) {
			log?.(`No compose file found for stack "${stackName}"`);
			log?.(`TIP: Import the stack in Dockhand for compose-native updates`);
			return false;
		}

		log?.(`Running: docker compose up -d ${serviceName}`);
		const result = await updateStackService(stackName, serviceName, envId, composeConfigPath);

		if (result.success) {
			log?.(`Service ${serviceName} updated via docker compose`);
			return true;
		} else {
			log?.(`docker compose up failed: ${result.error || 'Unknown error'}`);
			return false;
		}
	} catch (error: any) {
		log?.(`Stack update error: ${error.message}`);
		return false;
	}
}
