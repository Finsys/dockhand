/**
 * Environment Update Check Task
 *
 * Checks all containers in an environment for available image updates.
 * Can optionally auto-update containers when updates are found.
 */

import type { ScheduleTrigger, VulnerabilityCriteria } from '../../db';
import {
	getEnvUpdateCheckSettings,
	getEnvironment,
	createScheduleExecution,
	updateScheduleExecution,
	appendScheduleExecutionLog,
	saveVulnerabilityScan,
	clearPendingContainerUpdates,
	addPendingContainerUpdate,
	removePendingContainerUpdate
} from '../../db';
import {
	listContainers,
	inspectContainer,
	checkImageUpdateAvailable,
	pullImage,
	getTempImageTag,
	isDigestBasedImage,
	getImageIdByTag,
	removeTempImage,
	tagImage,
} from '../../docker';
import { sendEventNotification } from '../../notifications';
import { getScannerSettings, scanImage, type VulnerabilitySeverity } from '../../scanner';
import { parseImageNameAndTag, shouldBlockUpdate, combineScanSummaries, isSystemContainer } from './update-utils';
import { recreateContainer } from './container-update';

interface UpdateInfo {
	containerId: string;
	containerName: string;
	imageName: string;
	currentImageId: string;
	currentDigest?: string;
	newDigest?: string;
}

// Track running update checks to prevent concurrent execution
const runningUpdateChecks = new Set<number>();

/**
 * Execute environment update check job.
 * @param environmentId - The environment ID to check
 * @param triggeredBy - What triggered this execution
 */
export async function runEnvUpdateCheckJob(
	environmentId: number,
	triggeredBy: ScheduleTrigger = 'cron'
): Promise<void> {
	// Prevent concurrent execution for the same environment
	if (runningUpdateChecks.has(environmentId)) {
		console.log(`[EnvUpdateCheck] Environment ${environmentId} update check already running, skipping`);
		return;
	}

	runningUpdateChecks.add(environmentId);
	const startTime = Date.now();

	try {
	// Get environment info
	const env = await getEnvironment(environmentId);
	if (!env) {
		console.error(`[EnvUpdateCheck] Environment ${environmentId} not found`);
		return;
	}

	// Get settings
	const config = await getEnvUpdateCheckSettings(environmentId);
	if (!config) {
		console.error(`[EnvUpdateCheck] No settings found for environment ${environmentId}`);
		return;
	}

	// Create execution record
	const execution = await createScheduleExecution({
		scheduleType: 'env_update_check',
		scheduleId: environmentId,
		environmentId,
		entityName: `Update: ${env.name}`,
		triggeredBy,
		status: 'running'
	});

	await updateScheduleExecution(execution.id, {
		startedAt: new Date().toISOString()
	});

	const log = async (message: string) => {
		console.log(`[EnvUpdateCheck] ${message}`);
		await appendScheduleExecutionLog(execution.id, `[${new Date().toISOString()}] ${message}`);
	};

	try {
		await log(`Starting update check for environment: ${env.name}`);
		await log(`Auto-update mode: ${config.autoUpdate ? 'ON' : 'OFF'}`);

		// Clear pending updates at the start - we'll re-add as we discover updates
		await clearPendingContainerUpdates(environmentId);

		// Get all containers in this environment
		const containers = await listContainers(true, environmentId);
		await log(`Found ${containers.length} containers`);

		const updatesAvailable: UpdateInfo[] = [];
		let checkedCount = 0;
		let errorCount = 0;

		// Check each container for updates
		for (const container of containers) {
			try {
				const inspectData = await inspectContainer(container.id, environmentId) as any;
				const imageName = inspectData.Config?.Image;
				const currentImageId = inspectData.Image;

				if (!imageName) {
					await log(`  [${container.name}] Skipping - no image name found`);
					continue;
				}

				if (isSystemContainer(imageName)) {
					await log(`  [${container.name}] Skipping - system container`);
					continue;
				}

				checkedCount++;
				await log(`  Checking: ${container.name} (${imageName})`);

				const result = await checkImageUpdateAvailable(imageName, currentImageId, environmentId);

				if (result.isLocalImage) {
					await log(`    Local image - skipping update check`);
					continue;
				}

				if (result.error) {
					await log(`    Error: ${result.error}`);
					errorCount++;
					continue;
				}

				if (result.hasUpdate) {
					updatesAvailable.push({
						containerId: container.id,
						containerName: container.name,
						imageName,
						currentImageId,
						currentDigest: result.currentDigest,
						newDigest: result.registryDigest
					});
					// Add to pending table immediately - will be removed on successful update
					await addPendingContainerUpdate(environmentId, container.id, container.name, imageName);
					await log(`    UPDATE AVAILABLE`);
					await log(`      Current: ${result.currentDigest?.substring(0, 24) || 'unknown'}...`);
					await log(`      New:     ${result.registryDigest?.substring(0, 24) || 'unknown'}...`);
				} else {
					await log(`    Up to date`);
				}
			} catch (err: any) {
				await log(`  [${container.name}] Error: ${err.message}`);
				errorCount++;
			}
		}

		// Summary
		await log('');
		await log('=== SUMMARY ===');
		await log(`Total containers: ${containers.length}`);
		await log(`Checked: ${checkedCount}`);
		await log(`Updates available: ${updatesAvailable.length}`);
		await log(`Errors: ${errorCount}`);

		if (updatesAvailable.length === 0) {
			await log('All containers are up to date');
			// Pending updates already cleared at start, nothing to add
			await updateScheduleExecution(execution.id, {
				status: 'success',
				completedAt: new Date().toISOString(),
				duration: Date.now() - startTime,
				details: {
					updatesFound: 0,
					containersChecked: checkedCount,
					errors: errorCount
				}
			});
			return;
		}

		// Build notification message with details
		const updateList = updatesAvailable
			.map(u => {
				const currentShort = u.currentDigest?.substring(0, 12) || 'unknown';
				const newShort = u.newDigest?.substring(0, 12) || 'unknown';
				return `- ${u.containerName} (${u.imageName})\n  ${currentShort}... -> ${newShort}...`;
			})
			.join('\n');

		if (config.autoUpdate) {
			// Auto-update mode: actually update the containers with safe-pull flow
			await log('');
			await log('=== AUTO-UPDATE MODE ===');

			// Get scanner settings and vulnerability criteria
			const scannerSettings = await getScannerSettings(environmentId);
			const vulnerabilityCriteria = (config.vulnerabilityCriteria || 'never') as VulnerabilityCriteria;
			// Scan if scanning is enabled (scanner !== 'none')
			// The vulnerabilityCriteria only controls whether to BLOCK updates, not whether to SCAN
			const shouldScan = scannerSettings.scanner !== 'none';

			await log(`Vulnerability criteria: ${vulnerabilityCriteria}`);
			if (shouldScan) {
				await log(`Scanner: ${scannerSettings.scanner} (scan enabled)`);
			}
			await log(`Updating ${updatesAvailable.length} containers...`);

			let successCount = 0;
			let failCount = 0;
			let blockedCount = 0;
			const updatedContainers: string[] = [];
			const failedContainers: string[] = [];
			const blockedContainers: { name: string; reason: string; scannerResults?: { scanner: string; critical: number; high: number; medium: number; low: number }[] }[] = [];

			for (const update of updatesAvailable) {
				try {
					await log(`\nUpdating: ${update.containerName}`);

					// SAFE-PULL FLOW
					if (shouldScan && !isDigestBasedImage(update.imageName)) {
						const tempTag = getTempImageTag(update.imageName);
						await log(`  Safe-pull with temp tag: ${tempTag}`);

						// Step 1: Pull new image
						await log(`  Pulling ${update.imageName}...`);
						await pullImage(update.imageName, () => {}, environmentId);

						// Step 2: Get new image ID
						const newImageId = await getImageIdByTag(update.imageName, environmentId);
						if (!newImageId) {
							throw new Error('Failed to get new image ID after pull');
						}
						await log(`  New image: ${newImageId.substring(0, 19)}`);

						// Step 3: SAFETY - Restore original tag to old image
						const [oldRepo, oldTag] = parseImageNameAndTag(update.imageName);
						await tagImage(update.currentImageId, oldRepo, oldTag, environmentId);
						await log(`  Restored original tag to safe image`);

						// Step 4: Tag new image with temp suffix
						const [tempRepo, tempTagName] = parseImageNameAndTag(tempTag);
						await tagImage(newImageId, tempRepo, tempTagName, environmentId);

						// Step 5: Scan temp image
						await log(`  Scanning for vulnerabilities...`);
						let scanBlocked = false;
						let blockReason = '';
						let currentScannerResults: { scanner: string; critical: number; high: number; medium: number; low: number }[] = [];

						// Collect scan logs to log after scan completes
						const scanLogs: string[] = [];

						try {
							const scanResults = await scanImage(tempTag, environmentId, (progress) => {
								if (progress.message) {
									scanLogs.push(`  [${progress.scanner || 'scan'}] ${progress.message}`);
								}
							});

							// Log collected scan messages
							for (const scanLog of scanLogs) {
								await log(scanLog);
							}

							if (scanResults.length > 0) {
								const scanSummary = combineScanSummaries(scanResults);
								await log(`  Scan: ${scanSummary.critical} critical, ${scanSummary.high} high, ${scanSummary.medium} medium, ${scanSummary.low} low`);

								// Capture per-scanner results for blocking info
								currentScannerResults = scanResults.map(r => ({
									scanner: r.scanner,
									critical: r.summary.critical,
									high: r.summary.high,
									medium: r.summary.medium,
									low: r.summary.low
								}));

								// Save scan results
								for (const result of scanResults) {
									try {
										await saveVulnerabilityScan({
											environmentId,
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
									} catch { /* ignore save errors */ }
								}

								// Check if blocked
								const { blocked, reason } = shouldBlockUpdate(vulnerabilityCriteria, scanSummary, undefined);
								if (blocked) {
									scanBlocked = true;
									blockReason = reason;
								}
							}
						} catch (scanErr: any) {
							await log(`  Scan failed: ${scanErr.message}`);
							scanBlocked = true;
							blockReason = `Scan failed: ${scanErr.message}`;
						}

						if (scanBlocked) {
							// BLOCKED - Remove temp image
							await log(`  UPDATE BLOCKED: ${blockReason}`);
							await removeTempImage(newImageId, environmentId);
							await log(`  Removed blocked image - container stays safe`);
							blockedCount++;
							blockedContainers.push({
								name: update.containerName,
								reason: blockReason,
								scannerResults: currentScannerResults.length > 0 ? currentScannerResults : undefined
							});
							continue;
						}

						// APPROVED - Re-tag to original
						await log(`  Scan passed, re-tagging...`);
						await tagImage(newImageId, oldRepo, oldTag, environmentId);
						try {
							await removeTempImage(tempTag, environmentId);
						} catch { /* ignore cleanup errors */ }
					} else {
						// Simple pull (no scanning or digest-based image)
						await log(`  Pulling ${update.imageName}...`);
						await pullImage(update.imageName, () => {}, environmentId);
					}

					// Recreate container with full config passthrough
					await log(`  Recreating container...`);
					const ok = await recreateContainer(update.containerName, environmentId,
						(msg) => { log(`  ${msg}`); });
					if (!ok) throw new Error('Container recreation failed');

					await log(`  Updated successfully`);
					successCount++;
					updatedContainers.push(update.containerName);
					// Remove from pending table - successfully updated
					await removePendingContainerUpdate(environmentId, update.containerId);
				} catch (err: any) {
					await log(`  FAILED: ${err.message}`);
					failCount++;
					failedContainers.push(update.containerName);
				}
			}

			await log('');
			await log(`=== UPDATE COMPLETE ===`);
			await log(`Updated: ${successCount}`);
			await log(`Blocked: ${blockedCount}`);
			await log(`Failed: ${failCount}`);

			// Send notifications
			if (blockedCount > 0) {
				await sendEventNotification('auto_update_blocked', {
					title: `${blockedCount} update(s) blocked in ${env.name}`,
					message: blockedContainers.map(c => `- ${c.name}: ${c.reason}`).join('\n'),
					type: 'warning'
				}, environmentId);
			}

			const notificationMessage = successCount > 0
				? `Updated ${successCount} container(s) in ${env.name}:\n${updatedContainers.map(c => `- ${c}`).join('\n')}${blockedCount > 0 ? `\n\nBlocked (${blockedCount}):\n${blockedContainers.map(c => `- ${c.name}`).join('\n')}` : ''}${failCount > 0 ? `\n\nFailed (${failCount}):\n${failedContainers.map(c => `- ${c}`).join('\n')}` : ''}`
				: blockedCount > 0 ? `All updates blocked in ${env.name}` : `Update failed for all containers in ${env.name}`;

			await sendEventNotification('batch_update_success', {
				title: successCount > 0 ? `Containers updated in ${env.name}` : blockedCount > 0 ? `Updates blocked in ${env.name}` : `Container updates failed in ${env.name}`,
				message: notificationMessage,
				type: successCount > 0 && failCount === 0 && blockedCount === 0 ? 'success' : successCount > 0 ? 'warning' : 'error'
			}, environmentId);

			// Blocked/failed containers stay in pending table (successfully updated ones were removed)

			await updateScheduleExecution(execution.id, {
				status: failCount > 0 && successCount === 0 && blockedCount === 0 ? 'failed' : 'success',
				completedAt: new Date().toISOString(),
				duration: Date.now() - startTime,
				details: {
					mode: 'auto_update',
					updatesFound: updatesAvailable.length,
					containersChecked: checkedCount,
					errors: errorCount,
					autoUpdate: true,
					vulnerabilityCriteria,
					summary: { checked: checkedCount, updated: successCount, blocked: blockedCount, failed: failCount },
					containers: [
						...updatedContainers.map(name => ({ name, status: 'updated' as const })),
						...blockedContainers.map(c => ({ name: c.name, status: 'blocked' as const, blockReason: c.reason, scannerResults: c.scannerResults })),
						...failedContainers.map(name => ({ name, status: 'failed' as const }))
					],
					updated: successCount,
					blocked: blockedCount,
					failed: failCount,
					blockedContainers
				}
			});
		} else {
			// Check-only mode: just send notification
			await log('');
			await log('Check-only mode - sending notification about available updates');
			// Pending updates already added as we discovered them

			await sendEventNotification('updates_detected', {
				title: `Container updates available in ${env.name}`,
				message: `${updatesAvailable.length} update(s) available:\n${updateList}`,
				type: 'info'
			}, environmentId);

			await updateScheduleExecution(execution.id, {
				status: 'success',
				completedAt: new Date().toISOString(),
				duration: Date.now() - startTime,
				details: {
					mode: 'notify_only',
					updatesFound: updatesAvailable.length,
					containersChecked: checkedCount,
					errors: errorCount,
					autoUpdate: false,
					summary: { checked: checkedCount, updated: 0, blocked: 0, failed: 0 },
					containers: updatesAvailable.map(u => ({
						name: u.containerName,
						status: 'checked' as const,
						imageName: u.imageName,
						currentDigest: u.currentDigest,
						newDigest: u.newDigest
					}))
				}
			});
		}
	} catch (error: any) {
		await log(`Error: ${error.message}`);
		await updateScheduleExecution(execution.id, {
			status: 'failed',
			completedAt: new Date().toISOString(),
			duration: Date.now() - startTime,
			errorMessage: error.message
		});
	}
	} finally {
		runningUpdateChecks.delete(environmentId);
	}
}
