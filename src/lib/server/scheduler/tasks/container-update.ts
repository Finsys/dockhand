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
	connectContainerToNetwork
} from '../../docker';
import { getScannerSettings, scanImage, type ScanResult, type VulnerabilitySeverity } from '../../scanner';
import { sendEventNotification } from '../../notifications';
import { parseImageNameAndTag, shouldBlockUpdate, combineScanSummaries, isSystemContainer } from './update-utils';
import { startStack, getStackComposeFile } from '../../stacks';

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

		// Get the actual image ID from inspect data
		const currentImageId = inspectData.Image;

		log(`Container is using image: ${imageNameFromConfig}`);
		log(`Current image ID: ${currentImageId?.substring(0, 19)}`);

		// Detect if container is part of a Docker Compose stack
		const containerLabels = inspectData.Config?.Labels || {};
		const composeProject = containerLabels['com.docker.compose.project'];
		const composeService = containerLabels['com.docker.compose.service'];
		const isStackContainer = !!composeProject;

		if (isStackContainer) {
			log(`Container is part of compose stack: ${composeProject} (service: ${composeService})`);
		} else {
			log(`Container is standalone (not part of a compose stack)`);
		}

		// Get scanner and schedule settings early to determine scan strategy
		const [scannerSettings, updateSetting] = await Promise.all([
			getScannerSettings(envId),
			getAutoUpdateSettingById(settingId)
		]);

		const vulnerabilityCriteria = (updateSetting?.vulnerabilityCriteria || 'never') as VulnerabilityCriteria;
		// Scan if scanning is enabled (scanner !== 'none')
		// The vulnerabilityCriteria only controls whether to BLOCK updates, not whether to SCAN
		const shouldScan = scannerSettings.scanner !== 'none';

		// =============================================================================
		// SAFE UPDATE FLOW
		// =============================================================================
		// 1. Registry check (no pull) - determine if update is available
		// 2. If scanning enabled:
		//    a. Pull new image (overwrites original tag temporarily)
		//    b. Get new image ID
		//    c. SAFETY: Restore original tag to point to OLD image
		//    d. Tag new image with temp suffix for scanning
		//    e. Scan temp image
		//    f. If blocked: remove temp image, original tag still safe
		//    g. If approved: re-tag to original and proceed
		// 3. If no scanning: simple pull and update
		// =============================================================================

		// Step 1: Check for update using registry check (no pull)
		log(`Checking registry for updates: ${imageNameFromConfig}`);
		const registryCheck = await checkImageUpdateAvailable(imageNameFromConfig, currentImageId, envId);

		// Handle local images or registry errors
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
			// Don't fail on transient errors, just skip this run
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

		// Variables for scan results
		let scanResults: ScanResult[] | undefined;
		let scanSummary: VulnerabilitySeverity | undefined;
		let newImageId: string | null = null;
		const newDigest = registryCheck.registryDigest;

		// Step 2: Safe pull with temp tag protection (if scanning enabled)
		if (shouldScan) {
			log(`Safe-pull enabled (scanner: ${scannerSettings.scanner}, criteria: ${vulnerabilityCriteria})`);

			// Check if this is a digest-based image (can't use temp tags)
			if (isDigestBasedImage(imageNameFromConfig)) {
				log(`Digest-based image detected - temp tag protection not available`);
				// Fall through to simple flow
			} else {
				const tempTag = getTempImageTag(imageNameFromConfig);
				log(`Using temp tag for safe pull: ${tempTag}`);

				try {
					// Step 2a: Pull new image (overwrites original tag)
					log(`Pulling new image: ${imageNameFromConfig}`);
					await pullImage(imageNameFromConfig, undefined, envId);

					// Step 2b: Get new image ID
					newImageId = await getImageIdByTag(imageNameFromConfig, envId);
					if (!newImageId) {
						throw new Error('Failed to get new image ID after pull');
					}
					log(`New image pulled: ${newImageId.substring(0, 19)}`);

					// Step 2c: SAFETY - Restore original tag to OLD image
					log(`Restoring original tag to current safe image...`);
					const [oldRepo, oldTag] = parseImageNameAndTag(imageNameFromConfig);
					await tagImage(currentImageId, oldRepo, oldTag, envId);
					log(`Original tag ${imageNameFromConfig} restored to safe image`);

					// Step 2d: Tag new image with temp suffix
					const [tempRepo, tempTagName] = parseImageNameAndTag(tempTag);
					await tagImage(newImageId, tempRepo, tempTagName, envId);
					log(`New image tagged as: ${tempTag}`);

					// Step 2e: Scan temp image
					log(`Scanning new image for vulnerabilities...`);
					try {
						scanResults = await scanImage(tempTag, envId, (progress) => {
							const scannerTag = progress.scanner ? `[${progress.scanner}]` : '[scan]';
							if (progress.message) {
								log(`${scannerTag} ${progress.message}`);
							}
							if (progress.output) {
								log(`${scannerTag} ${progress.output}`);
							}
						});

						if (scanResults.length > 0) {
							scanSummary = combineScanSummaries(scanResults);
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

							// Handle 'more_than_current' criteria
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
								// Step 2f: BLOCKED - Remove temp image, original tag is safe
								log(`UPDATE BLOCKED: ${reason}`);
								log(`Removing blocked image: ${tempTag}`);
								await removeTempImage(newImageId, envId);
								log(`Blocked image removed - container will continue using safe image`);

								await updateScheduleExecution(execution.id, {
									status: 'skipped',
									completedAt: new Date().toISOString(),
									duration: Date.now() - startTime,
									details: {
										mode: 'auto_update',
										reason: 'vulnerabilities_found',
										blockReason: reason,
										vulnerabilityCriteria,
										summary: { checked: 1, updated: 0, blocked: 1, failed: 0 },
										containers: [{
											name: containerName,
											status: 'blocked',
											blockReason: reason,
											scannerResults: scanResults.map(r => ({
												scanner: r.scanner,
												critical: r.summary.critical,
												high: r.summary.high,
												medium: r.summary.medium,
												low: r.summary.low,
												negligible: r.summary.negligible,
												unknown: r.summary.unknown
											}))
										}],
										scanResult: {
											summary: scanSummary,
											scanners: scanResults.map(r => r.scanner),
											scannedAt: scanResults[0]?.scannedAt,
											scannerResults: scanResults.map(r => ({
												scanner: r.scanner,
												critical: r.summary.critical,
												high: r.summary.high,
												medium: r.summary.medium,
												low: r.summary.low,
												negligible: r.summary.negligible,
												unknown: r.summary.unknown
											}))
										}
									}
								});

								await sendEventNotification('auto_update_blocked', {
									title: 'Auto-update blocked',
									message: `Container "${containerName}" update blocked: ${reason}`,
									type: 'warning'
								}, envId);

								return;
							}

							log(`Scan passed vulnerability criteria`);
						}
					} catch (scanError: any) {
						// Scan failure - cleanup temp image and fail
						log(`Scan failed: ${scanError.message}`);
						log(`Removing temp image due to scan failure...`);
						await removeTempImage(newImageId, envId);

						await updateScheduleExecution(execution.id, {
							status: 'failed',
							completedAt: new Date().toISOString(),
							duration: Date.now() - startTime,
							errorMessage: `Vulnerability scan failed: ${scanError.message}`
						});
						return;
					}

					// Step 2g: APPROVED - Re-tag to original for update
					log(`Re-tagging approved image to: ${imageNameFromConfig}`);
					await tagImage(newImageId, oldRepo, oldTag, envId);
					log(`Image ready for update`);

					// Clean up temp tag (optional, image will be removed when container is recreated)
					try {
						await removeTempImage(tempTag, envId);
					} catch { /* ignore cleanup errors */ }

				} catch (pullError: any) {
					log(`Safe-pull failed: ${pullError.message}`);
					await updateScheduleExecution(execution.id, {
						status: 'failed',
						completedAt: new Date().toISOString(),
						duration: Date.now() - startTime,
						errorMessage: `Failed to pull image: ${pullError.message}`
					});
					return;
				}
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
		// Update the container based on type
		// =============================================================================
		let success = false;

		if (isStackContainer) {
			log(`Updating via docker compose for stack: ${composeProject}`);

			// Try stack-based update first
			const stackSuccess = await updateStackContainer(composeProject!, composeService!, envId, log);

			if (stackSuccess) {
				success = true;
			} else {
				// Fallback: Stack is external (not managed by Dockhand), use container recreation
				log(`Fallback: Recreating container directly (stack "${composeProject}" not managed by Dockhand)`);
				log(`WARNING: Some compose-specific settings may not be preserved`);
				log(`Consider importing this stack into Dockhand for full configuration preservation`);
				success = await recreateContainer(containerName, envId, log);
			}
		} else {
			log(`Updating standalone container via recreation...`);
			success = await recreateContainer(containerName, envId, log);
		}

		if (success) {
			await updateAutoUpdateLastUpdated(containerName, envId);
			log(`Successfully updated container: ${containerName}`);
			await updateScheduleExecution(execution.id, {
				status: 'success',
				completedAt: new Date().toISOString(),
				duration: Date.now() - startTime,
				details: {
					mode: 'auto_update',
					newDigest,
					vulnerabilityCriteria,
					summary: { checked: 1, updated: 1, blocked: 0, failed: 0 },
					containers: [{
						name: containerName,
						status: 'updated',
						scannerResults: scanResults?.map(r => ({
							scanner: r.scanner,
							critical: r.summary.critical,
							high: r.summary.high,
							medium: r.summary.medium,
							low: r.summary.low,
							negligible: r.summary.negligible,
							unknown: r.summary.unknown
						}))
					}],
					scanResult: scanSummary ? {
						summary: scanSummary,
						scanners: scanResults?.map(r => r.scanner) || [],
						scannedAt: scanResults?.[0]?.scannedAt,
						scannerResults: scanResults?.map(r => ({
							scanner: r.scanner,
							critical: r.summary.critical,
							high: r.summary.high,
							medium: r.summary.medium,
							low: r.summary.low,
							negligible: r.summary.negligible,
							unknown: r.summary.unknown
						})) || []
					} : undefined
				}
			});

			// Send notification for successful update
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

		// Send notification for failed update
		await sendEventNotification('auto_update_failed', {
			title: 'Auto-update failed',
			message: `Container "${containerName}" auto-update failed: ${error.message}`,
			type: 'error'
		}, envId);
	}
}

// =============================================================================
// EXPORTED HELPER FUNCTIONS (reused by batch-update-stream and batch-update)
// =============================================================================

/**
 * Recreate a standalone container with comprehensive settings preservation.
 * Extracts and preserves 50+ container settings from the original container.
 *
 * Note: For containers that are part of a Docker Compose stack, use
 * updateStackContainer() instead, which uses `docker compose up -d` to
 * preserve ALL settings including network aliases, static IPs, etc.
 */
export async function recreateContainer(
	containerName: string,
	envId?: number,
	log?: (msg: string) => void
): Promise<boolean> {
	try {
		// Find the container by name
		const containers = await listContainers(true, envId);
		const container = containers.find(c => c.name === containerName);

		if (!container) {
			log?.(`Container not found: ${containerName}`);
			return false;
		}

		// Get full container config
		const inspectData = await inspectContainer(container.id, envId) as any;
		const wasRunning = inspectData.State.Running;
		const config = inspectData.Config;
		const hostConfig = inspectData.HostConfig;

		log?.(`Recreating container: ${containerName} (was running: ${wasRunning})`);
		log?.(`Preserving all container settings...`);

		// Stop container if running
		if (wasRunning) {
			log?.('Stopping container...');
			await stopContainer(container.id, envId);
		}

		// Remove old container
		log?.('Removing old container...');
		await removeContainer(container.id, true, envId);

		// =============================================================================
		// Extract ALL settings from the original container
		// =============================================================================

		// Port bindings - preserve all host port mappings including HostIp
		const ports: { [key: string]: { HostIp?: string; HostPort: string } } = {};
		if (hostConfig.PortBindings) {
			for (const [containerPort, bindings] of Object.entries(hostConfig.PortBindings)) {
				if (bindings && (bindings as any[]).length > 0) {
					const binding = (bindings as any[])[0];
					ports[containerPort] = {
						HostPort: binding.HostPort || ''
					};
					// Preserve HostIp if specified (e.g., '192.168.0.250:80:80' in compose)
					if (binding.HostIp) {
						ports[containerPort].HostIp = binding.HostIp;
					}
				}
			}
		}

		// Volume bindings - preserve ALL volumes including anonymous volumes
		// hostConfig.Binds contains named volumes and bind mounts in "source:dest" format
		// inspectData.Mounts contains ALL mounts including anonymous volumes with their generated names
		const volumeBinds: string[] = [];
		const mountedPaths = new Set<string>();

		// First, add all entries from hostConfig.Binds (named volumes and bind mounts)
		if (hostConfig.Binds && Array.isArray(hostConfig.Binds)) {
			for (const bind of hostConfig.Binds) {
				volumeBinds.push(bind);
				// Track the destination path to avoid duplicates
				const parts = bind.split(':');
				if (parts.length >= 2) {
					mountedPaths.add(parts[1].split(':')[0]); // Handle "src:dest:ro" format
				}
			}
		}

		// Then, add anonymous volumes from Mounts that aren't already in Binds
		// These have Type: "volume" and a generated Name (hash), but no entry in Binds
		const mounts = inspectData.Mounts || [];
		for (const mount of mounts) {
			if (mount.Type === 'volume' && mount.Name && mount.Destination) {
				// Skip if this destination is already covered by Binds
				if (!mountedPaths.has(mount.Destination)) {
					// Format: "volumeName:destination" or "volumeName:destination:ro"
					const bindStr = mount.RW === false
						? `${mount.Name}:${mount.Destination}:ro`
						: `${mount.Name}:${mount.Destination}`;
					volumeBinds.push(bindStr);
					log?.(`Preserving anonymous volume: ${mount.Name} -> ${mount.Destination}`);
				}
			}
		}

		// Healthcheck configuration
		let healthcheck: any = undefined;
		if (config.Healthcheck && config.Healthcheck.Test && config.Healthcheck.Test.length > 0) {
			// Skip if healthcheck is disabled (NONE)
			if (config.Healthcheck.Test[0] !== 'NONE') {
				healthcheck = {
					test: config.Healthcheck.Test,
					interval: config.Healthcheck.Interval,
					timeout: config.Healthcheck.Timeout,
					retries: config.Healthcheck.Retries,
					startPeriod: config.Healthcheck.StartPeriod
				};
			}
		}

		// Device mappings
		const devices = (hostConfig.Devices || []).map((d: any) => ({
			hostPath: d.PathOnHost || '',
			containerPath: d.PathInContainer || '',
			permissions: d.CgroupPermissions || 'rwm'
		})).filter((d: any) => d.hostPath && d.containerPath);

		// Ulimits
		const ulimits = (hostConfig.Ulimits || []).map((u: any) => ({
			name: u.Name,
			soft: u.Soft,
			hard: u.Hard
		}));

		// Extract network connections with aliases and static IPs
		const networkSettings = inspectData.NetworkSettings?.Networks || {};
		const primaryNetwork = hostConfig.NetworkMode || 'bridge';

		// Build network info for reconnection (including aliases, IPs, and gateway priority)
		interface NetworkInfo {
			name: string;
			aliases: string[];
			ipv4Address: string | undefined;
			ipv6Address: string | undefined;
			gwPriority: number | undefined;
		}

		// Extract primary network aliases, static IP, and gateway priority (for createContainer)
		let primaryNetworkAliases: string[] | undefined;
		let primaryNetworkIpv4: string | undefined;
		let primaryNetworkIpv6: string | undefined;
		let primaryNetworkMacAddress: string | undefined;
		let primaryNetworkGwPriority: number | undefined;

		const additionalNetworks: NetworkInfo[] = [];
		for (const [netName, netConfig] of Object.entries(networkSettings)) {
			const netConf = netConfig as any;

			// Check if this is the primary network
			const isPrimary = netName === primaryNetwork ||
				(primaryNetwork === 'bridge' && (netName === 'bridge' || netName === 'default'));

			if (isPrimary) {
				// Extract primary network's aliases and static IP
				// Filter out auto-generated aliases (container name and ID prefix)
				// Note: Docker Compose stores aliases in both Aliases and DNSNames,
				// but after container recreation Aliases may be null while DNSNames has the values
				const allAliases = (netConf.Aliases?.length > 0 ? netConf.Aliases : netConf.DNSNames) || [];
				const shortContainerId = container.id.substring(0, 12);
				primaryNetworkAliases = allAliases.filter((a: string) =>
					a !== containerName &&
					a !== container.id &&
					a !== shortContainerId
				);
				if (!primaryNetworkAliases || primaryNetworkAliases.length === 0) {
					primaryNetworkAliases = undefined;
				}

				// Extract static IP from IPAMConfig (user-configured) - don't use auto-assigned IPAddress
				primaryNetworkIpv4 = netConf.IPAMConfig?.IPv4Address || undefined;
				primaryNetworkIpv6 = netConf.IPAMConfig?.IPv6Address || undefined;

				// Extract MAC address (only if explicitly set, not auto-generated)
				// Auto-generated MACs start with 02:42, so we preserve all MACs
				primaryNetworkMacAddress = netConf.MacAddress || undefined;

				// Extract gateway priority (Docker Engine 28+)
				// GwPriority determines which network provides the default gateway
				primaryNetworkGwPriority = netConf.GwPriority !== undefined && netConf.GwPriority !== 0
					? netConf.GwPriority : undefined;

				if (primaryNetworkAliases?.length) {
					log?.(`Primary network aliases: ${primaryNetworkAliases.join(', ')}`);
				}
				if (primaryNetworkIpv4) {
					log?.(`Primary network static IPv4: ${primaryNetworkIpv4}`);
				}
				if (primaryNetworkMacAddress) {
					log?.(`Primary network MAC address: ${primaryNetworkMacAddress}`);
				}
				if (primaryNetworkGwPriority !== undefined) {
					log?.(`Primary network gateway priority: ${primaryNetworkGwPriority}`);
				}
			} else {
				// Secondary network - add to reconnection list
				// Use DNSNames as fallback for aliases (see comment above for primary network)
				additionalNetworks.push({
					name: netName,
					aliases: (netConf.Aliases?.length > 0 ? netConf.Aliases : netConf.DNSNames) || [],
					ipv4Address: netConf.IPAMConfig?.IPv4Address || undefined,
					ipv6Address: netConf.IPAMConfig?.IPv6Address || undefined,
					gwPriority: netConf.GwPriority !== undefined && netConf.GwPriority !== 0
						? netConf.GwPriority : undefined
				});
			}
		}

		if (additionalNetworks.length > 0) {
			log?.(`Will reconnect to ${additionalNetworks.length} additional network(s): ${additionalNetworks.map(n => n.name).join(', ')}`);
		}

		// Log extra hosts if present
		if (hostConfig.ExtraHosts?.length > 0) {
			log?.(`Extra hosts: ${hostConfig.ExtraHosts.join(', ')}`);
		}

		// Log device requests if present (GPU, etc.)
		if (hostConfig.DeviceRequests?.length > 0) {
			for (const dr of hostConfig.DeviceRequests) {
				const caps = dr.Capabilities?.flat().join(',') || 'none';
				log?.(`Device request: driver=${dr.Driver || 'default'}, count=${dr.Count}, capabilities=[${caps}]`);
			}
		}

		// Create new container with ALL preserved settings
		log?.('Creating new container with preserved settings...');
		const newContainer = await createContainer({
			name: containerName,
			image: config.Image,

			// Command and entrypoint
			cmd: config.Cmd || undefined,
			entrypoint: config.Entrypoint || undefined,
			workingDir: config.WorkingDir || undefined,

			// Environment and labels
			env: config.Env || [],
			labels: config.Labels || {},

			// Port mappings
			ports: Object.keys(ports).length > 0 ? ports : undefined,

			// Volume bindings (includes both named and anonymous volumes)
			volumeBinds: volumeBinds.length > 0 ? volumeBinds : undefined,

			// Restart policy
			restartPolicy: hostConfig.RestartPolicy?.Name || 'no',
			restartMaxRetries: hostConfig.RestartPolicy?.MaximumRetryCount,

			// Network mode and network-specific settings
			networkMode: hostConfig.NetworkMode || undefined,
			networkAliases: primaryNetworkAliases,
			networkIpv4Address: primaryNetworkIpv4,
			networkIpv6Address: primaryNetworkIpv6,
			networkGwPriority: primaryNetworkGwPriority,

			// User and hostname
			user: config.User || undefined,
			hostname: config.Hostname || undefined,

			// Privileged mode
			privileged: hostConfig.Privileged || undefined,

			// Healthcheck
			healthcheck,

			// Terminal settings
			tty: config.Tty || undefined,
			stdinOpen: config.OpenStdin || undefined,

			// Memory limits
			memory: hostConfig.Memory || undefined,
			memoryReservation: hostConfig.MemoryReservation || undefined,
			memorySwap: hostConfig.MemorySwap || undefined,

			// CPU limits
			cpuShares: hostConfig.CpuShares || undefined,
			cpuQuota: hostConfig.CpuQuota || undefined,
			cpuPeriod: hostConfig.CpuPeriod || undefined,
			nanoCpus: hostConfig.NanoCpus || undefined,

			// Capabilities
			capAdd: hostConfig.CapAdd?.length > 0 ? hostConfig.CapAdd : undefined,
			capDrop: hostConfig.CapDrop?.length > 0 ? hostConfig.CapDrop : undefined,

			// Devices
			devices: devices.length > 0 ? devices : undefined,

			// DNS settings
			dns: hostConfig.Dns?.length > 0 ? hostConfig.Dns : undefined,
			dnsSearch: hostConfig.DnsSearch?.length > 0 ? hostConfig.DnsSearch : undefined,
			dnsOptions: hostConfig.DnsOptions?.length > 0 ? hostConfig.DnsOptions : undefined,

			// Security options
			securityOpt: hostConfig.SecurityOpt?.length > 0 ? hostConfig.SecurityOpt : undefined,

			// Ulimits
			ulimits: ulimits.length > 0 ? ulimits : undefined,

			// Process and memory settings
			oomKillDisable: hostConfig.OomKillDisable || undefined,
			pidsLimit: hostConfig.PidsLimit || undefined,
			shmSize: hostConfig.ShmSize || undefined,

			// Tmpfs mounts
			tmpfs: hostConfig.Tmpfs && Object.keys(hostConfig.Tmpfs).length > 0 ? hostConfig.Tmpfs : undefined,

			// Sysctls
			sysctls: hostConfig.Sysctls && Object.keys(hostConfig.Sysctls).length > 0 ? hostConfig.Sysctls : undefined,

			// Logging configuration
			logDriver: hostConfig.LogConfig?.Type || undefined,
			logOptions: hostConfig.LogConfig?.Config && Object.keys(hostConfig.LogConfig.Config).length > 0
				? hostConfig.LogConfig.Config : undefined,

			// Namespace settings
			ipcMode: hostConfig.IpcMode || undefined,
			pidMode: hostConfig.PidMode || undefined,
			utsMode: hostConfig.UTSMode || undefined,

			// Cgroup parent
			cgroupParent: hostConfig.CgroupParent || undefined,

			// Stop signal and timeout
			stopSignal: config.StopSignal || undefined,
			stopTimeout: config.StopTimeout || undefined,

			// Init process
			init: hostConfig.Init === true ? true : undefined,

			// MAC address (from primary network settings)
			macAddress: primaryNetworkMacAddress,

			// Extra hosts (/etc/hosts entries)
			extraHosts: hostConfig.ExtraHosts?.length > 0 ? hostConfig.ExtraHosts : undefined,

			// Device requests (GPU access, etc.)
			deviceRequests: hostConfig.DeviceRequests?.length > 0
				? hostConfig.DeviceRequests.map((dr: any) => ({
					driver: dr.Driver || undefined,
					count: dr.Count,
					deviceIDs: dr.DeviceIDs?.length > 0 ? dr.DeviceIDs : undefined,
					capabilities: dr.Capabilities?.length > 0 ? dr.Capabilities : undefined,
					options: dr.Options && Object.keys(dr.Options).length > 0 ? dr.Options : undefined
				}))
				: undefined,

			// Container runtime (critical for GPU containers using nvidia runtime)
			runtime: hostConfig.Runtime && hostConfig.Runtime !== 'runc' ? hostConfig.Runtime : undefined,

			// Read-only root filesystem (security hardening)
			readonlyRootfs: hostConfig.ReadonlyRootfs === true ? true : undefined,

			// CPU pinning
			cpusetCpus: hostConfig.CpusetCpus || undefined,

			// NUMA memory nodes
			cpusetMems: hostConfig.CpusetMems || undefined,

			// Additional groups
			groupAdd: hostConfig.GroupAdd?.length > 0 ? hostConfig.GroupAdd : undefined,

			// Memory swappiness (0-100)
			memorySwappiness: hostConfig.MemorySwappiness !== null ? hostConfig.MemorySwappiness : undefined,

			// User namespace mode
			usernsMode: hostConfig.UsernsMode || undefined,

			// Domain name
			domainname: config.Domainname || undefined
		}, envId);

		// Reconnect to additional networks with aliases, static IPs, and gateway priority (before starting)
		if (additionalNetworks.length > 0) {
			log?.(`Reconnecting to ${additionalNetworks.length} additional network(s)...`);
			for (const netInfo of additionalNetworks) {
				try {
					await connectContainerToNetwork(netInfo.name, newContainer.id, envId, {
						aliases: netInfo.aliases.length > 0 ? netInfo.aliases : undefined,
						ipv4Address: netInfo.ipv4Address,
						ipv6Address: netInfo.ipv6Address,
						gwPriority: netInfo.gwPriority
					});
					log?.(`  Connected to: ${netInfo.name}`);
					if (netInfo.aliases.length > 0) {
						log?.(`    Aliases: ${netInfo.aliases.join(', ')}`);
					}
					if (netInfo.ipv4Address) {
						log?.(`    Static IPv4: ${netInfo.ipv4Address}`);
					}
					if (netInfo.gwPriority !== undefined) {
						log?.(`    Gateway priority: ${netInfo.gwPriority}`);
					}
				} catch (netError: any) {
					log?.(`  Warning: Failed to connect to network "${netInfo.name}": ${netError.message}`);
					// Don't fail the entire update for network connection issues
				}
			}
		}

		// Start if was running
		if (wasRunning) {
			log?.('Starting new container...');
			await newContainer.start();
		}

		log?.('Container recreated successfully with all settings preserved');
		return true;
	} catch (error: any) {
		log?.(`Failed to recreate container: ${error.message}`);
		return false;
	}
}

/**
 * Update a container that is part of a Docker Compose stack.
 * Uses `docker compose up -d` which preserves ALL configuration from the compose file.
 *
 * @param stackName - The compose project name (com.docker.compose.project label)
 * @param serviceName - The service name within the stack (com.docker.compose.service label)
 * @param envId - Optional environment ID
 * @param log - Optional logging function
 * @returns true if update succeeded, false if stack not found (use fallback)
 */
export async function updateStackContainer(
	stackName: string,
	serviceName: string,
	envId?: number,
	log?: (msg: string) => void
): Promise<boolean> {
	try {
		log?.(`Looking up stack configuration for: ${stackName}`);

		// Check if we have the compose file for this stack
		const composeResult = await getStackComposeFile(stackName, envId);

		if (!composeResult.success || !composeResult.content) {
			// Stack is "external" - we don't have the compose file
			log?.(`WARNING: No compose file found for stack "${stackName}"`);
			log?.(`This stack may have been created outside Dockhand`);
			log?.(`Falling back to container recreation (some settings may be lost)`);
			log?.(`TIP: Import the stack in Dockhand to preserve all settings on future updates`);
			return false; // Signal to use fallback
		}

		log?.(`Found compose file for stack: ${stackName}`);
		log?.(`Running: docker compose up -d (service: ${serviceName})`);

		// Use startStack which runs `docker compose up -d`
		// This will recreate only containers with changed images
		const result = await startStack(stackName, envId);

		if (result.success) {
			log?.(`Stack updated successfully via docker compose`);
			if (result.output) {
				// Log compose output (shows which containers were recreated)
				const lines = result.output.split('\n').filter((l: string) => l.trim());
				for (const line of lines) {
					log?.(`[compose] ${line}`);
				}
			}
			return true;
		} else {
			log?.(`docker compose up failed: ${result.error || 'Unknown error'}`);
			if (result.output) {
				log?.(`Output: ${result.output}`);
			}
			return false;
		}
	} catch (error: any) {
		log?.(`Stack update error: ${error.message}`);
		return false;
	}
}
