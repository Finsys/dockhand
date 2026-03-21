import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import {
	listContainers,
	inspectContainer,
	pullImage,
	getTempImageTag,
	isDigestBasedImage,
	getImageIdByTag,
	removeTempImage,
	tagImage
} from '$lib/server/docker';
import { auditContainer } from '$lib/server/audit';
import { getScannerSettings, scanImage } from '$lib/server/scanner';
import { saveVulnerabilityScan, removePendingContainerUpdate, type VulnerabilityCriteria } from '$lib/server/db';
import { parseImageNameAndTag, shouldBlockUpdate, combineScanSummaries, isDockhandContainer } from '$lib/server/scheduler/tasks/update-utils';
import { recreateContainer } from '$lib/server/scheduler/tasks/container-update';
import { createJob, appendLine, completeJob, failJob } from '$lib/server/jobs';

export interface ScanResult {
	critical: number;
	high: number;
	medium: number;
	low: number;
	negligible?: number;
	unknown?: number;
}

export interface ScannerResult extends ScanResult {
	scanner: 'grype' | 'trivy';
}

export interface UpdateProgress {
	type: 'start' | 'progress' | 'pull_log' | 'scan_start' | 'scan_log' | 'scan_complete' | 'blocked' | 'complete' | 'error';
	containerId?: string;
	containerName?: string;
	step?: 'pulling' | 'scanning' | 'stopping' | 'removing' | 'creating' | 'starting' | 'done' | 'failed' | 'blocked' | 'skipped';
	message?: string;
	current?: number;
	total?: number;
	success?: boolean;
	error?: string;
	summary?: {
		total: number;
		success: number;
		failed: number;
		blocked: number;
		skipped: number;
	};
	// Pull log specific fields
	pullStatus?: string;
	pullId?: string;
	pullProgress?: string;
	// Scan specific fields
	scanResult?: ScanResult;
	scannerResults?: ScannerResult[];
	blockReason?: string;
	scanner?: string;
	vulnerabilities?: Array<{
		id: string;
		severity: string;
		package: string;
		version: string;
		fixedVersion?: string;
		link?: string;
		scanner: string;
	}>;
}

/**
 * Batch update containers with streaming progress.
 * Expects JSON body: { containerIds: string[], vulnerabilityCriteria?: VulnerabilityCriteria }
 */
export const POST: RequestHandler = async (event) => {
	const { url, cookies, request } = event;
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Need create permission to recreate containers
	if (auth.authEnabled && !await auth.can('containers', 'create', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	let body: { containerIds: string[]; vulnerabilityCriteria?: VulnerabilityCriteria };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const { containerIds, vulnerabilityCriteria = 'never' } = body;

	if (!containerIds || !Array.isArray(containerIds) || containerIds.length === 0) {
		return json({ error: 'containerIds array is required' }, { status: 400 });
	}

	// Job pattern: create job, run in background, return jobId immediately
	const job = createJob();

	const sendData = (data: UpdateProgress) => {
		appendLine(job, { data });
	};

	(async () => {
		let successCount = 0;
		let failCount = 0;
		let blockedCount = 0;
		let skippedCount = 0;

		// Get scanner settings for this environment
		const scannerSettings = await getScannerSettings(envIdNum);
		// Scan if scanning is enabled (scanner !== 'none')
		// The vulnerabilityCriteria only controls whether to BLOCK updates, not whether to SCAN
		const shouldScan = scannerSettings.scanner !== 'none';

		// Send start event
		sendData({
			type: 'start',
			total: containerIds.length,
			message: `Starting update of ${containerIds.length} container${containerIds.length > 1 ? 's' : ''}${shouldScan ? ' with vulnerability scanning' : ''}`
		});

		// Process containers sequentially
		for (let i = 0; i < containerIds.length; i++) {
			const containerId = containerIds[i];
			let containerName = 'unknown';

			try {
				// Find container
				const containers = await listContainers(true, envIdNum);
				const container = containers.find(c => c.id === containerId);

				if (!container) {
					sendData({
						type: 'progress',
						containerId,
						containerName: 'unknown',
						step: 'failed',
						current: i + 1,
						total: containerIds.length,
						success: false,
						error: 'Container not found'
					});
					failCount++;
					continue;
				}

				containerName = container.name;

				// Get full container config
				const inspectData = await inspectContainer(containerId, envIdNum) as any;
				const config = inspectData.Config;
				const imageName = config.Image;
				const currentImageId = inspectData.Image;

				// Skip Dockhand container - cannot update itself
				if (isDockhandContainer(imageName)) {
					sendData({
						type: 'progress',
						containerId,
						containerName,
						step: 'skipped',
						current: i + 1,
						total: containerIds.length,
						success: true,
						message: `Skipping ${containerName} - cannot update Dockhand itself`
					});
					skippedCount++;
					continue;
				}

				// Skip digest-pinned images - they are explicitly locked to a specific version
				if (isDigestBasedImage(imageName)) {
					sendData({
						type: 'progress',
						containerId,
						containerName,
						step: 'skipped',
						current: i + 1,
						total: containerIds.length,
						success: true,
						message: `Skipping ${containerName} - image pinned to specific digest`
					});
					skippedCount++;
					continue;
				}

				// Step 1: Pull latest image
				sendData({
					type: 'progress',
					containerId,
					containerName,
					step: 'pulling',
					current: i + 1,
					total: containerIds.length,
					message: `Pulling ${imageName}...`
				});

				try {
					await pullImage(imageName, (data: any) => {
						if (data.status) {
							sendData({
								type: 'pull_log',
								containerId,
								containerName,
								pullStatus: data.status,
								pullId: data.id,
								pullProgress: data.progress
							});
						}
					}, envIdNum);
				} catch (pullError: any) {
					sendData({
						type: 'progress',
						containerId,
						containerName,
						step: 'failed',
						current: i + 1,
						total: containerIds.length,
						success: false,
						error: `Pull failed: ${pullError.message}`
					});
					failCount++;
					continue;
				}

				// SAFE-PULL FLOW with vulnerability scanning
				if (shouldScan && !isDigestBasedImage(imageName)) {
					const tempTag = getTempImageTag(imageName);

					// Get new image ID
					const newImageId = await getImageIdByTag(imageName, envIdNum);
					if (!newImageId) {
						sendData({
							type: 'progress',
							containerId,
							containerName,
							step: 'failed',
							current: i + 1,
							total: containerIds.length,
							success: false,
							error: 'Failed to get new image ID after pull'
						});
						failCount++;
						continue;
					}

					// Restore original tag to old image (safety)
					const [oldRepo, oldTag] = parseImageNameAndTag(imageName);
					try {
						await tagImage(currentImageId, oldRepo, oldTag, envIdNum);
					} catch {
						// Ignore - old image might have been removed
					}

					// Tag new image with temp suffix
					const [tempRepo, tempTagName] = parseImageNameAndTag(tempTag);
					await tagImage(newImageId, tempRepo, tempTagName, envIdNum);

					// Step 2: Scan temp image
					sendData({
						type: 'scan_start',
						containerId,
						containerName,
						step: 'scanning',
						current: i + 1,
						total: containerIds.length,
						message: `Scanning ${imageName} for vulnerabilities...`
					});

					let scanBlocked = false;
					let blockReason = '';
					let individualScannerResults: ScannerResult[] = [];

					try {
						const scanResults = await scanImage(tempTag, envIdNum, (progress) => {
							if (progress.output || progress.message) {
								sendData({
									type: 'scan_log',
									containerId,
									containerName,
									scanner: progress.scanner,
									message: progress.output || progress.message
								});
							}
						});

						if (scanResults.length > 0) {
							// Build individual scanner results (used by frontend)
							individualScannerResults = scanResults.map(result => ({
								scanner: result.scanner as 'grype' | 'trivy',
								critical: result.summary.critical,
								high: result.summary.high,
								medium: result.summary.medium,
								low: result.summary.low,
								negligible: result.summary.negligible,
								unknown: result.summary.unknown
							}));

							// Save scan results
							for (const result of scanResults) {
								try {
									await saveVulnerabilityScan({
										environmentId: envIdNum,
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

							// Check if blocked (combineScanSummaries uses Math.max for security check)
							const combinedForBlockCheck = combineScanSummaries(scanResults);
							const { blocked, reason } = shouldBlockUpdate(vulnerabilityCriteria, combinedForBlockCheck, undefined);
							if (blocked) {
								scanBlocked = true;
								blockReason = reason;
							}
						}

						// Collect vulnerabilities from all scanners (cap at 100)
						const vulnerabilities = scanResults
							.flatMap(r => r.vulnerabilities || [])
							.slice(0, 100)
							.map(v => ({
								id: v.id,
								severity: v.severity,
								package: v.package,
								version: v.version,
								fixedVersion: v.fixedVersion,
								link: v.link,
								scanner: v.scanner
							}));

						// Build scan message from individual results
						const totalCritical = individualScannerResults.reduce((s, r) => s + r.critical, 0);
						const totalHigh = individualScannerResults.reduce((s, r) => s + r.high, 0);
						const totalMedium = individualScannerResults.reduce((s, r) => s + r.medium, 0);
						const totalLow = individualScannerResults.reduce((s, r) => s + r.low, 0);
						const hasVulns = totalCritical + totalHigh + totalMedium + totalLow > 0;

						sendData({
							type: 'scan_complete',
							containerId,
							containerName,
							scannerResults: individualScannerResults.length > 0 ? individualScannerResults : undefined,
							vulnerabilities: vulnerabilities.length > 0 ? vulnerabilities : undefined,
							message: hasVulns
								? `Scan complete: ${totalCritical} critical, ${totalHigh} high, ${totalMedium} medium, ${totalLow} low`
								: 'Scan complete: no vulnerabilities found'
						});

					} catch (scanErr: any) {
						sendData({
							type: 'progress',
							containerId,
							containerName,
							step: 'failed',
							current: i + 1,
							total: containerIds.length,
							success: false,
							error: `Scan failed: ${scanErr.message}`
						});

						// Clean up temp image on scan failure
						try {
							await removeTempImage(newImageId, envIdNum);
						} catch { /* ignore cleanup errors */ }

						failCount++;
						continue;
					}

					if (scanBlocked) {
						// BLOCKED - Remove temp image and skip this container
						sendData({
							type: 'blocked',
							containerId,
							containerName,
							step: 'blocked',
							current: i + 1,
							total: containerIds.length,
							success: false,
							scannerResults: individualScannerResults.length > 0 ? individualScannerResults : undefined,
							blockReason,
							message: `Update blocked: ${blockReason}`
						});

						try {
							await removeTempImage(newImageId, envIdNum);
						} catch { /* ignore cleanup errors */ }

						blockedCount++;
						continue;
					}

					// APPROVED - Re-tag to original
					await tagImage(newImageId, oldRepo, oldTag, envIdNum);
					try {
						await removeTempImage(tempTag, envIdNum);
					} catch { /* ignore cleanup errors */ }
				}

				// Progress logging function for shared functions
				const logProgress = (message: string) => {
					sendData({
						type: 'progress',
						containerId,
						containerName,
						step: 'creating',
						current: i + 1,
						total: containerIds.length,
						message
					});
				};

				let newContainerId = containerId;

				sendData({
					type: 'progress',
					containerId,
					containerName,
					step: 'creating',
					current: i + 1,
					total: containerIds.length,
					message: `Recreating ${containerName}...`
				});

				const recreateResult = await recreateContainer(containerName, envIdNum, logProgress, imageName);
				if (recreateResult.success) {
					const updatedContainers = await listContainers(true, envIdNum);
					const updatedContainer = updatedContainers.find(c => c.name === containerName);
					if (updatedContainer) {
						newContainerId = updatedContainer.id;
					}
				}

				if (!recreateResult.success) {
					sendData({
						type: 'progress',
						containerId,
						containerName,
						step: 'failed',
						current: i + 1,
						total: containerIds.length,
						success: false,
						error: recreateResult.error || 'Container recreation failed'
					});
					failCount++;
					continue;
				}

				// Audit log
				await auditContainer(event, 'update', newContainerId, containerName, envIdNum, { batchUpdate: true });

				// Done with this container - use original containerId for UI consistency
				sendData({
					type: 'progress',
					containerId,
					containerName,
					step: 'done',
					current: i + 1,
					total: containerIds.length,
					success: true,
					message: `${containerName} updated successfully`
				});
				successCount++;

				// Clear pending update indicator from database
				if (envIdNum) {
					await removePendingContainerUpdate(envIdNum, containerId).catch(() => {
						// Ignore errors - record may not exist
					});
				}

			} catch (error: any) {
				sendData({
					type: 'progress',
					containerId,
					containerName,
					step: 'failed',
					current: i + 1,
					total: containerIds.length,
					success: false,
					error: error.message
				});
				failCount++;
			}
		}

		// Send complete event
		const completeData: UpdateProgress = {
			type: 'complete',
			summary: {
				total: containerIds.length,
				success: successCount,
				failed: failCount,
				blocked: blockedCount,
				skipped: skippedCount
			},
			message: skippedCount > 0 || blockedCount > 0
				? `Updated ${successCount} of ${containerIds.length} containers${blockedCount > 0 ? ` (${blockedCount} blocked)` : ''}${skippedCount > 0 ? ` (${skippedCount} skipped)` : ''}`
				: `Updated ${successCount} of ${containerIds.length} containers`
		};
		sendData(completeData);
		completeJob(job, completeData);
	})().catch((err) => {
		failJob(job, err instanceof Error ? err.message : String(err));
	});

	return json({ jobId: job.id });
};
