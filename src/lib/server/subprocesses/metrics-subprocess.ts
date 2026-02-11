/**
 * Metrics Collection Subprocess
 *
 * Runs as a separate process via Bun.spawn to collect CPU/memory metrics
 * and check disk space without blocking the main HTTP thread.
 *
 * Communication with main process via IPC (process.send).
 */

import { getEnvironments, getEnvSetting, getMetricsCollectionInterval } from '../db';
import { listContainers, getContainerStats, getDockerInfo, getDiskUsage } from '../docker';
import os from 'node:os';
import type { MainProcessCommand } from '../subprocess-manager';

let COLLECT_INTERVAL = 30000; // 30 seconds (default, will be loaded from settings)
const DISK_CHECK_INTERVAL = 300000; // 5 minutes
const DEFAULT_DISK_THRESHOLD = 80; // 80% threshold for disk warnings
const ENV_METRICS_TIMEOUT = 15000; // 15 seconds timeout per environment for metrics
const ENV_DISK_TIMEOUT = 20000; // 20 seconds timeout per environment for disk checks

/**
 * Timeout wrapper - returns fallback if promise takes too long
 * IMPORTANT: Properly clears the timeout to prevent memory leaks
 */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | null = null;

	const timeoutPromise = new Promise<T>((resolve) => {
		timeoutId = setTimeout(() => resolve(fallback), ms);
	});

	return Promise.race([promise, timeoutPromise]).finally(() => {
		if (timeoutId !== null) {
			clearTimeout(timeoutId);
		}
	});
}

// Track last disk warning sent per environment to avoid spamming
const lastDiskWarning: Map<number, number> = new Map();
const DISK_WARNING_COOLDOWN = 3600000; // 1 hour between warnings

let collectInterval: ReturnType<typeof setInterval> | null = null;
let diskCheckInterval: ReturnType<typeof setInterval> | null = null;
let isShuttingDown = false;
let collectionCycleCount = 0;
const MEMORY_LOG_INTERVAL = 10; // Log memory every 10 cycles (~5 minutes at 30s interval)

/**
 * Send message to main process
 */
function send(message: any): void {
	if (process.send) {
		process.send(message);
	}
}

/**
 * Collect metrics for a single environment
 */
async function collectEnvMetrics(env: { id: number; name: string; host?: string; socketPath?: string; collectMetrics?: boolean; connectionType?: string }) {
	try {
		// Skip environments where metrics collection is disabled
		if (env.collectMetrics === false) {
			return;
		}

		// Skip Hawser Edge environments (handled by main process)
		if (env.connectionType === 'hawser-edge') {
			return;
		}

		// Get running containers
		const containers = await listContainers(false, env.id); // Only running
		let totalCpuPercent = 0;
		let totalContainerMemUsed = 0;

		// Get stats for each running container
		const statsPromises = containers.map(async (container) => {
			try {
				const stats = (await getContainerStats(container.id, env.id)) as any;

				// Calculate CPU percentage
				const cpuDelta =
					stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
				const systemDelta =
					stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
				const cpuCount = stats.cpu_stats.online_cpus || os.cpus().length;

				let cpuPercent = 0;
				if (systemDelta > 0 && cpuDelta > 0) {
					cpuPercent = (cpuDelta / systemDelta) * cpuCount * 100;
				}

				// Get container memory usage using the same formula as Docker CLI
				// Docker subtracts cache (inactive_file) from total usage
				// - cgroup v2: uses 'inactive_file'
				// - cgroup v1: uses 'total_inactive_file'
				const memUsage = stats.memory_stats?.usage || 0;
				const memStats = stats.memory_stats?.stats || {};
				const memCache = memStats.inactive_file ?? memStats.total_inactive_file ?? 0;
				const actualMemUsed = memCache > 0 && memCache < memUsage ? memUsage - memCache : memUsage;

				return { cpuPercent, memUsage: actualMemUsed };
			} catch {
				return { cpuPercent: 0, memUsage: 0 };
			}
		});

		const statsResults = await Promise.all(statsPromises);
		totalCpuPercent = statsResults.reduce((sum, r) => sum + r.cpuPercent, 0);
		totalContainerMemUsed = statsResults.reduce((sum, r) => sum + r.memUsage, 0);

		// Get host memory info from Docker
		const info = (await getDockerInfo(env.id)) as any;
		const memTotal = info?.MemTotal || os.totalmem();

		// Calculate memory: sum of all container memory vs host total
		const memUsed = totalContainerMemUsed;
		const memPercent = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;

		// Normalize CPU by number of cores from the Docker host
		const cpuCount = info?.NCPU || os.cpus().length;
		const normalizedCpu = totalCpuPercent / cpuCount;

		// Validate values - skip if any are NaN, Infinity, or negative
		const finalCpu = Number.isFinite(normalizedCpu) && normalizedCpu >= 0 ? normalizedCpu : 0;
		const finalMemPercent = Number.isFinite(memPercent) && memPercent >= 0 ? memPercent : 0;
		const finalMemUsed = Number.isFinite(memUsed) && memUsed >= 0 ? memUsed : 0;
		const finalMemTotal = Number.isFinite(memTotal) && memTotal > 0 ? memTotal : 0;

		// Only send if we have valid memory total (otherwise metrics are meaningless)
		if (finalMemTotal > 0) {
			send({
				type: 'metric',
				envId: env.id,
				cpu: finalCpu,
				memPercent: finalMemPercent,
				memUsed: finalMemUsed,
				memTotal: finalMemTotal
			});
		}
	} catch (error) {
		// Skip this environment if it fails (might be offline)
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[MetricsSubprocess] Failed to collect metrics for ${env.name}: ${message}`);
	}
}

/**
 * Collect metrics for all environments
 */
async function collectMetrics() {
	if (isShuttingDown) return;

	try {
		const environments = await getEnvironments();

		// Filter enabled environments and collect metrics in parallel
		const enabledEnvs = environments.filter((env) => env.collectMetrics !== false);

		// Process all environments in parallel with per-environment timeouts
		// Use Promise.allSettled so one slow/failed env doesn't block others
		const results = await Promise.allSettled(
			enabledEnvs.map((env) =>
				withTimeout(
					collectEnvMetrics(env).then(() => env.name),
					ENV_METRICS_TIMEOUT,
					null
				)
			)
		);

		// Log any environments that timed out
		results.forEach((result, index) => {
			if (result.status === 'fulfilled' && result.value === null) {
				console.warn(`[MetricsSubprocess] Environment "${enabledEnvs[index].name}" metrics timed out after ${ENV_METRICS_TIMEOUT}ms`);
			} else if (result.status === 'rejected') {
				const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
				console.warn(`[MetricsSubprocess] Environment "${enabledEnvs[index].name}" metrics failed: ${reason}`);
			}
		});

		// Periodic memory logging for diagnostics
		collectionCycleCount++;
		if (collectionCycleCount % MEMORY_LOG_INTERVAL === 0) {
			const memUsage = process.memoryUsage();
			const heapMB = Math.round(memUsage.heapUsed / 1024 / 1024);
			const rssMB = Math.round(memUsage.rss / 1024 / 1024);
			console.log(`[MetricsSubprocess] Memory: heap=${heapMB}MB, rss=${rssMB}MB (cycle ${collectionCycleCount})`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[MetricsSubprocess] Metrics collection error: ${message}`);
		send({ type: 'error', message: `Metrics collection error: ${message}` });
	}
}

/**
 * Parse size string like "107.4GB" to bytes
 */
function parseSize(sizeStr: string): number {
	const units: Record<string, number> = {
		B: 1,
		KB: 1024,
		MB: 1024 * 1024,
		GB: 1024 * 1024 * 1024,
		TB: 1024 * 1024 * 1024 * 1024
	};

	const match = sizeStr.match(/^([\d.]+)\s*([KMGT]?B)$/i);
	if (!match) return 0;

	const value = parseFloat(match[1]);
	const unit = match[2].toUpperCase();
	return value * (units[unit] || 1);
}

/**
 * Format bytes to human readable string
 */
function formatSize(bytes: number): string {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let unitIndex = 0;
	let size = bytes;

	while (size >= 1024 && unitIndex < units.length - 1) {
		size /= 1024;
		unitIndex++;
	}

	return `${size.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Check disk space for a single environment
 */
async function checkEnvDiskSpace(env: { id: number; name: string; collectMetrics?: boolean; connectionType?: string }) {
	try {
		// Skip environments where metrics collection is disabled
		if (env.collectMetrics === false) {
			return;
		}

		// Skip Hawser Edge environments (handled by main process)
		if (env.connectionType === 'hawser-edge') {
			return;
		}

		// Check if we're in cooldown for this environment
		const lastWarningTime = lastDiskWarning.get(env.id);
		if (lastWarningTime && Date.now() - lastWarningTime < DISK_WARNING_COOLDOWN) {
			return; // Skip this environment, still in cooldown
		}

		// Get Docker disk usage data
		const diskData = (await getDiskUsage(env.id)) as any;
		if (!diskData) return;

		// Calculate total Docker disk usage using reduce for cleaner code
		let totalUsed = 0;
		if (diskData.Images) {
			totalUsed += diskData.Images.reduce((sum: number, img: any) => sum + (img.Size || 0), 0);
		}
		if (diskData.Containers) {
			totalUsed += diskData.Containers.reduce((sum: number, c: any) => sum + (c.SizeRw || 0), 0);
		}
		if (diskData.Volumes) {
			totalUsed += diskData.Volumes.reduce(
				(sum: number, v: any) => sum + (v.UsageData?.Size || 0),
				0
			);
		}
		if (diskData.BuildCache) {
			totalUsed += diskData.BuildCache.reduce((sum: number, bc: any) => sum + (bc.Size || 0), 0);
		}

		// Get Docker root filesystem info from Docker info
		const info = (await getDockerInfo(env.id)) as any;
		const driverStatus = info?.DriverStatus;

		// Try to find "Data Space Total" from driver status
		let dataSpaceTotal = 0;
		let diskPercentUsed = 0;

		if (driverStatus) {
			for (const [key, value] of driverStatus) {
				if (key === 'Data Space Total' && typeof value === 'string') {
					dataSpaceTotal = parseSize(value);
					break;
				}
			}
		}

		// If we found total disk space, calculate percentage
		if (dataSpaceTotal > 0) {
			diskPercentUsed = (totalUsed / dataSpaceTotal) * 100;
		} else {
			// Fallback: just report absolute usage if we can't determine percentage
			const GB = 1024 * 1024 * 1024;
			if (totalUsed > 50 * GB) {
				send({
					type: 'disk_warning',
					envId: env.id,
					envName: env.name,
					message: `Environment "${env.name}" is using ${formatSize(totalUsed)} of Docker disk space`
				});
				lastDiskWarning.set(env.id, Date.now());
			}
			return;
		}

		// Check against threshold
		const threshold =
			(await getEnvSetting('disk_warning_threshold', env.id)) || DEFAULT_DISK_THRESHOLD;
		if (diskPercentUsed >= threshold) {
			console.log(
				`[MetricsSubprocess] Docker disk usage for ${env.name}: ${diskPercentUsed.toFixed(1)}% (threshold: ${threshold}%)`
			);

			send({
				type: 'disk_warning',
				envId: env.id,
				envName: env.name,
				message: `Environment "${env.name}" Docker disk usage is at ${diskPercentUsed.toFixed(1)}% (${formatSize(totalUsed)} used)`,
				diskPercent: diskPercentUsed
			});

			lastDiskWarning.set(env.id, Date.now());
		}
	} catch (error) {
		// Skip this environment if it fails
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[MetricsSubprocess] Failed to check disk space for ${env.name}: ${message}`);
	}
}

/**
 * Check disk space for all environments
 */
async function checkDiskSpace() {
	if (isShuttingDown) return;

	try {
		const environments = await getEnvironments();

		// Filter enabled environments and check disk space in parallel
		const enabledEnvs = environments.filter((env) => env.collectMetrics !== false);

		// Process all environments in parallel with per-environment timeouts
		// Use Promise.allSettled so one slow/failed env doesn't block others
		const results = await Promise.allSettled(
			enabledEnvs.map((env) =>
				withTimeout(
					checkEnvDiskSpace(env).then(() => env.name),
					ENV_DISK_TIMEOUT,
					null
				)
			)
		);

		// Log any environments that timed out
		results.forEach((result, index) => {
			if (result.status === 'fulfilled' && result.value === null) {
				console.warn(`[MetricsSubprocess] Environment "${enabledEnvs[index].name}" disk check timed out after ${ENV_DISK_TIMEOUT}ms`);
			} else if (result.status === 'rejected') {
				const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
				console.warn(`[MetricsSubprocess] Environment "${enabledEnvs[index].name}" disk check failed: ${reason}`);
			}
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[MetricsSubprocess] Disk space check error: ${message}`);
		send({ type: 'error', message: `Disk space check error: ${message}` });
	}
}

/**
 * Handle commands from main process
 */
function handleCommand(command: MainProcessCommand): void {
	switch (command.type) {
		case 'refresh_environments':
			console.log('[MetricsSubprocess] Refreshing environments...');
			// The next collection cycle will pick up the new environments
			break;

		case 'update_interval':
			console.log(`[MetricsSubprocess] Updating collection interval to ${command.intervalMs}ms`);
			COLLECT_INTERVAL = command.intervalMs;
			// Clear existing interval and restart with new timing
			if (collectInterval) {
				clearInterval(collectInterval);
				collectInterval = setInterval(collectMetrics, COLLECT_INTERVAL);
			}
			break;

		case 'shutdown':
			console.log('[MetricsSubprocess] Shutdown requested');
			shutdown();
			break;
	}
}

/**
 * Graceful shutdown
 */
function shutdown(): void {
	isShuttingDown = true;

	if (collectInterval) {
		clearInterval(collectInterval);
		collectInterval = null;
	}
	if (diskCheckInterval) {
		clearInterval(diskCheckInterval);
		diskCheckInterval = null;
	}

	lastDiskWarning.clear();
	console.log('[MetricsSubprocess] Stopped');
	process.exit(0);
}

/**
 * Start the metrics collector
 */
async function start(): Promise<void> {
	// Load interval from settings
	try {
		COLLECT_INTERVAL = await getMetricsCollectionInterval();
		console.log(`[MetricsSubprocess] Starting metrics collection (every ${COLLECT_INTERVAL / 1000}s)...`);
	} catch (error) {
		console.error('[MetricsSubprocess] Failed to load interval from settings, using default 30s');
		COLLECT_INTERVAL = 30000;
	}

	// Initial collection
	collectMetrics();

	// Schedule regular collection
	collectInterval = setInterval(collectMetrics, COLLECT_INTERVAL);

	// Start disk space checking (every 5 minutes) - can be disabled for Synology NAS
	const skipDfCollection = process.env.SKIP_DF_COLLECTION === 'true' || process.env.SKIP_DF_COLLECTION === '1';
	if (!skipDfCollection) {
		console.log('[MetricsSubprocess] Starting disk space monitoring (every 5 minutes)');
		checkDiskSpace(); // Initial check
		diskCheckInterval = setInterval(checkDiskSpace, DISK_CHECK_INTERVAL);
	} else {
		console.log('[MetricsSubprocess] Disk space monitoring disabled (SKIP_DF_COLLECTION=true)');
	}

	// Start memory diagnostics logging (every 5 minutes)
	setInterval(() => {
		const mem = process.memoryUsage();
		console.log(
			`[MetricsSubprocess] Memory: heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB, ` +
			`rss=${Math.round(mem.rss / 1024 / 1024)}MB`
		);
	}, 5 * 60 * 1000);

	// Listen for commands from main process
	process.on('message', (message: MainProcessCommand) => {
		handleCommand(message);
	});

	// Handle termination signals
	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);

	// Signal ready
	send({ type: 'ready' });

	console.log('[MetricsSubprocess] Started successfully');
}

// Start the subprocess
start();
