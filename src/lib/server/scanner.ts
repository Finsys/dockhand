// Vulnerability Scanner Service
// Supports Grype and Trivy scanners
// Uses long-running containers for faster subsequent scans (cached vulnerability databases)

import {
	listImages,
	pullImage,
	createVolume,
	listVolumes,
	removeVolume,
	runContainer,
	runContainerWithStreaming,
	inspectImage,
	checkImageUpdateAvailable
} from './docker';
import { getEnvironment, getEnvSetting, getSetting } from './db';
import { sendEventNotification } from './notifications';
import { getHostDockerSocket, getHostDataDir, extractUidFromSocketPath } from './host-path';
import { resolve } from 'node:path';
import { mkdir, chown } from 'node:fs/promises';

export type ScannerType = 'none' | 'grype' | 'trivy' | 'both';

/**
 * Send vulnerability notifications based on scan results.
 * Sends the most severe notification type based on found vulnerabilities.
 */
export async function sendVulnerabilityNotifications(
	imageName: string,
	summary: VulnerabilitySeverity,
	envId?: number
): Promise<void> {
	const totalVulns = summary.critical + summary.high + summary.medium + summary.low + summary.negligible + summary.unknown;

	if (totalVulns === 0) {
		// No vulnerabilities found, no notification needed
		return;
	}

	// Send notifications based on severity (most severe first)
	// Note: Users can subscribe to specific severity levels, so we send all applicable
	if (summary.critical > 0) {
		await sendEventNotification('vulnerability_critical', {
			title: 'Critical vulnerabilities found',
			message: `Image "${imageName}" has ${summary.critical} critical vulnerabilities (${totalVulns} total)`,
			type: 'error'
		}, envId);
	}

	if (summary.high > 0) {
		await sendEventNotification('vulnerability_high', {
			title: 'High severity vulnerabilities found',
			message: `Image "${imageName}" has ${summary.high} high severity vulnerabilities (${totalVulns} total)`,
			type: 'warning'
		}, envId);
	}

	// Only send 'any' notification if there are medium/low/negligible but no critical/high
	// This prevents notification spam for users who only want to know about lesser severities
	if (summary.critical === 0 && summary.high === 0 && totalVulns > 0) {
		await sendEventNotification('vulnerability_any', {
			title: 'Vulnerabilities found',
			message: `Image "${imageName}" has ${totalVulns} vulnerabilities (medium: ${summary.medium}, low: ${summary.low})`,
			type: 'info'
		}, envId);
	}
}

// Volume names for scanner database caching
const GRYPE_VOLUME_NAME = 'dockhand-grype-db';
const TRIVY_VOLUME_NAME = 'dockhand-trivy-db';

// Scanner cache directory for rootless Docker (bind mounts instead of volumes)
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const SCANNER_CACHE_DIR = 'scanner-cache';

// Per-type serial lock to prevent concurrent scans of the same scanner type.
// This avoids DB lock conflicts AND ensures the second scan uses warm cache
// instead of re-downloading the entire vulnerability database (~100MB).
const scannerLocks = new Map<string, Promise<void>>(); // key: "grype" or "trivy"

async function withScannerLock<T>(scannerType: string, fn: () => Promise<T>): Promise<T> {
	const existing = scannerLocks.get(scannerType);
	if (existing) {
		console.log(`[Scanner] Waiting for previous ${scannerType} scan to complete...`);
		await existing.catch(() => {}); // Don't fail if previous scan errored
	}

	let resolve: () => void;
	const lockPromise = new Promise<void>(r => { resolve = r; });
	scannerLocks.set(scannerType, lockPromise);

	try {
		return await fn();
	} finally {
		resolve!();
		if (scannerLocks.get(scannerType) === lockPromise) {
			scannerLocks.delete(scannerType);
		}
	}
}

// Track in-progress scans per image to prevent duplicate scans
// Key: "{scannerType}:{imageName}", Value: Promise that resolves to the scan result
const inProgressScans = new Map<string, Promise<string>>();

// Default CLI arguments for scanners (image name is substituted for {image})
export const DEFAULT_GRYPE_ARGS = '-o json -v {image}';
export const DEFAULT_TRIVY_ARGS = 'image --format json {image}';

export interface VulnerabilitySeverity {
	critical: number;
	high: number;
	medium: number;
	low: number;
	negligible: number;
	unknown: number;
}

export interface Vulnerability {
	id: string;
	severity: string;
	package: string;
	version: string;
	fixedVersion?: string;
	description?: string;
	link?: string;
	scanner: 'grype' | 'trivy';
}

export interface ScanResult {
	imageId: string;
	imageName: string;
	scanner: 'grype' | 'trivy';
	scannedAt: string;
	vulnerabilities: Vulnerability[];
	summary: VulnerabilitySeverity;
	scanDuration: number;
	error?: string;
}

export interface ScanProgress {
	stage: 'checking' | 'pulling-scanner' | 'scanning' | 'parsing' | 'complete' | 'error';
	message: string;
	scanner?: 'grype' | 'trivy';
	progress?: number;
	result?: ScanResult;
	results?: ScanResult[]; // All scanner results when using 'both'
	error?: string;
	output?: string; // Line of scanner output
}

// Get global default scanner CLI args from general settings (or fallback to hardcoded defaults)
export async function getGlobalScannerDefaults(): Promise<{
	grypeArgs: string;
	trivyArgs: string;
}> {
	const [grypeArgs, trivyArgs] = await Promise.all([
		getSetting('default_grype_args'),
		getSetting('default_trivy_args')
	]);
	return {
		grypeArgs: grypeArgs ?? DEFAULT_GRYPE_ARGS,
		trivyArgs: trivyArgs ?? DEFAULT_TRIVY_ARGS
	};
}

// Get scanner settings (scanner type is per-environment, CLI args are global)
export async function getScannerSettings(envId?: number): Promise<{
	scanner: ScannerType;
	grypeArgs: string;
	trivyArgs: string;
}> {
	// CLI args are always global - no need for per-env settings
	const [globalDefaults, scanner] = await Promise.all([
		getGlobalScannerDefaults(),
		getEnvSetting('vulnerability_scanner', envId)
	]);

	return {
		scanner: scanner || 'none',
		grypeArgs: globalDefaults.grypeArgs,
		trivyArgs: globalDefaults.trivyArgs
	};
}

// Optimized version that accepts pre-cached global defaults (avoids redundant DB calls)
// Only looks up scanner type per-environment since CLI args are global
export async function getScannerSettingsWithDefaults(
	envId: number | undefined,
	globalDefaults: { grypeArgs: string; trivyArgs: string }
): Promise<{
	scanner: ScannerType;
	grypeArgs: string;
	trivyArgs: string;
}> {
	const scanner = await getEnvSetting('vulnerability_scanner', envId) || 'none';
	return {
		scanner,
		grypeArgs: globalDefaults.grypeArgs,
		trivyArgs: globalDefaults.trivyArgs
	};
}

// Parse CLI args string into array, substituting {image} placeholder
function parseCliArgs(argsString: string, imageName: string): string[] {
	// Replace {image} placeholder with actual image name
	const withImage = argsString.replace(/\{image\}/g, imageName);
	// Split by whitespace, respecting quoted strings
	const args: string[] = [];
	let current = '';
	let inQuote = false;
	let quoteChar = '';

	for (const char of withImage) {
		if ((char === '"' || char === "'") && !inQuote) {
			inQuote = true;
			quoteChar = char;
		} else if (char === quoteChar && inQuote) {
			inQuote = false;
			quoteChar = '';
		} else if (char === ' ' && !inQuote) {
			if (current) {
				args.push(current);
				current = '';
			}
		} else {
			current += char;
		}
	}
	if (current) {
		args.push(current);
	}
	return args;
}

// Check if a scanner image is available locally
async function isScannerImageAvailable(scannerImage: string, envId?: number): Promise<boolean> {
	try {
		const images = await listImages(envId);
		return images.some((img) =>
			img.tags?.some((tag: string) => tag.includes(scannerImage.split(':')[0]))
		);
	} catch {
		return false;
	}
}

// Pull scanner image if not available
async function ensureScannerImage(
	scannerImage: string,
	envId?: number,
	onProgress?: (progress: ScanProgress) => void
): Promise<boolean> {
	const isAvailable = await isScannerImageAvailable(scannerImage, envId);

	if (isAvailable) {
		return true;
	}

	onProgress?.({
		stage: 'pulling-scanner',
		message: `Pulling scanner image ${scannerImage}...`
	});

	try {
		await pullImage(scannerImage, undefined, envId);
		return true;
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error(`[Scanner] Failed to pull image ${scannerImage}:`, errorMsg);
		return false;
	}
}

// Extract JSON object from raw scanner output that may contain non-JSON content
// (binary Docker stream headers, warning lines, control characters)
function extractJson(output: string): string {
	const firstBrace = output.indexOf('{');
	const lastBrace = output.lastIndexOf('}');
	if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
		throw new Error('No JSON object found in scanner output');
	}
	return output.slice(firstBrace, lastBrace + 1);
}

/**
 * Sanitize control characters inside JSON string values that would cause parse failures.
 * Some scanners (Grype) may include raw control chars (newlines, tabs, null bytes)
 * in vulnerability descriptions that aren't properly JSON-escaped.
 */
function sanitizeJsonString(json: string): string {
	// Replace unescaped control characters (0x00-0x1F) inside JSON string values
	// by walking through the string and tracking whether we're inside a quoted string
	let result = '';
	let inString = false;
	let escaped = false;
	let sanitized = 0;

	for (let i = 0; i < json.length; i++) {
		const ch = json.charCodeAt(i);

		if (escaped) {
			result += json[i];
			escaped = false;
			continue;
		}

		if (inString) {
			if (ch === 0x5C) { // backslash
				result += json[i];
				escaped = true;
			} else if (ch === 0x22) { // closing quote
				result += json[i];
				inString = false;
			} else if (ch < 0x20) {
				// Control character inside a string - escape it
				if (ch === 0x0A) result += '\\n';
				else if (ch === 0x0D) result += '\\r';
				else if (ch === 0x09) result += '\\t';
				else result += `\\u${ch.toString(16).padStart(4, '0')}`;
				sanitized++;
			} else {
				result += json[i];
			}
		} else {
			if (ch === 0x22) { // opening quote
				inString = true;
			}
			result += json[i];
		}
	}

	if (sanitized > 0) {
		console.warn(`[Scanner] Sanitized ${sanitized} control characters in JSON output`);
	}

	return result;
}

// Parse Grype JSON output
function parseGrypeOutput(output: string): { vulnerabilities: Vulnerability[]; summary: VulnerabilitySeverity } {
	const vulnerabilities: Vulnerability[] = [];
	const summary: VulnerabilitySeverity = {
		critical: 0,
		high: 0,
		medium: 0,
		low: 0,
		negligible: 0,
		unknown: 0
	};

	console.log('[Grype] Raw output length:', output.length);
	console.log('[Grype] Output starts with:', output.slice(0, 200));
	console.log('[Grype] Output ends with:', JSON.stringify(output.slice(-50)));

	try {
		const data = JSON.parse(sanitizeJsonString(extractJson(output)));

		if (data.matches) {
			for (const match of data.matches) {
				const severity = (match.vulnerability?.severity || 'Unknown').toLowerCase();
				const vuln: Vulnerability = {
					id: match.vulnerability?.id || 'Unknown',
					severity: severity,
					package: match.artifact?.name || 'Unknown',
					version: match.artifact?.version || 'Unknown',
					fixedVersion: match.vulnerability?.fix?.versions?.[0],
					description: match.vulnerability?.description,
					link: match.vulnerability?.dataSource,
					scanner: 'grype'
				};
				vulnerabilities.push(vuln);

				// Count by severity
				if (severity === 'critical') summary.critical++;
				else if (severity === 'high') summary.high++;
				else if (severity === 'medium') summary.medium++;
				else if (severity === 'low') summary.low++;
				else if (severity === 'negligible') summary.negligible++;
				else summary.unknown++;
			}
		}
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error('[Grype] Failed to parse output:', errorMsg);
		console.error('[Grype] Output length:', output.length);
		console.error('[Grype] First 200 chars:', output.slice(0, 200));
		console.error('[Grype] Last 200 chars:', output.slice(-200));
		// Check if output looks like an error message from grype
		const firstLine = output.split('\n')[0].trim();
		if (firstLine && !firstLine.startsWith('{')) {
			throw new Error(`Scanner output error: ${firstLine}`);
		}
		throw new Error('Failed to parse scanner output - ensure CLI args include "-o json"');
	}

	return { vulnerabilities, summary };
}

// Parse Trivy JSON output
function parseTrivyOutput(output: string): { vulnerabilities: Vulnerability[]; summary: VulnerabilitySeverity } {
	const vulnerabilities: Vulnerability[] = [];
	const summary: VulnerabilitySeverity = {
		critical: 0,
		high: 0,
		medium: 0,
		low: 0,
		negligible: 0,
		unknown: 0
	};

	try {
		const data = JSON.parse(sanitizeJsonString(extractJson(output)));

		const results = data.Results || [];
		for (const result of results) {
			const vulns = result.Vulnerabilities || [];
			for (const v of vulns) {
				const severity = (v.Severity || 'Unknown').toLowerCase();
				const vuln: Vulnerability = {
					id: v.VulnerabilityID || 'Unknown',
					severity: severity,
					package: v.PkgName || 'Unknown',
					version: v.InstalledVersion || 'Unknown',
					fixedVersion: v.FixedVersion,
					description: v.Description,
					link: v.PrimaryURL || v.References?.[0],
					scanner: 'trivy'
				};
				vulnerabilities.push(vuln);

				// Count by severity
				if (severity === 'critical') summary.critical++;
				else if (severity === 'high') summary.high++;
				else if (severity === 'medium') summary.medium++;
				else if (severity === 'low') summary.low++;
				else if (severity === 'negligible') summary.negligible++;
				else summary.unknown++;
			}
		}
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error('[Trivy] Failed to parse output:', errorMsg);
		console.error('[Trivy] Output length:', output.length);
		console.error('[Trivy] First 32 bytes (hex):', Buffer.from(output.slice(0, 32)).toString('hex'));
		console.error('[Trivy] Full output:', output);
		// Check if output looks like an error message from trivy
		const firstLine = output.split('\n')[0].trim();
		if (firstLine && !firstLine.startsWith('{')) {
			throw new Error(`Scanner output error: ${firstLine}`);
		}
		throw new Error('Failed to parse scanner output - ensure CLI args include "--format json"');
	}

	return { vulnerabilities, summary };
}

// Get the SHA256 image ID for a given image name/tag
async function getImageSha(imageName: string, envId?: number): Promise<string> {
	try {
		const imageInfo = await inspectImage(imageName, envId) as any;
		// The Id field contains the full sha256:... hash
		return imageInfo.Id || imageName;
	} catch {
		// If we can't inspect the image, fall back to the name
		return imageName;
	}
}

// Ensure a named volume exists for caching scanner databases
async function ensureVolume(volumeName: string, envId?: number): Promise<void> {
	const volumes = await listVolumes(envId);
	const exists = volumes.some(v => v.name === volumeName);
	if (!exists) {
		console.log(`[Scanner] Creating database volume: ${volumeName}`);
		await createVolume({ name: volumeName }, envId);
	} else {
		console.log(`[Scanner] Using existing database volume: ${volumeName}`);
	}
}

/**
 * Ensure scanner cache directory exists with correct ownership for rootless Docker.
 * Creates the directory in Dockhand's data volume and chowns it to the target UID.
 *
 * This is needed because Docker volumes are always created with root ownership,
 * but rootless Docker scanners run as a non-root user (e.g., UID 1000).
 * By using a bind mount from Dockhand's data directory (which Dockhand can chown
 * since it runs as root), the scanner can write to its cache.
 *
 * @param scannerType - 'grype' or 'trivy'
 * @param uid - Target UID for ownership (e.g., '1000')
 * @returns The HOST path to the cache directory (for bind mounting into scanner)
 */
async function ensureScannerCacheDir(
	scannerType: 'grype' | 'trivy',
	uid: string
): Promise<string> {
	const containerPath = resolve(DATA_DIR, SCANNER_CACHE_DIR, scannerType);

	// Create directory if needed (recursive)
	await mkdir(containerPath, { recursive: true });

	// Chown to the target UID so scanner can write
	const uidNum = parseInt(uid, 10);
	await chown(containerPath, uidNum, uidNum);
	console.log(`[Scanner] Set ownership of ${containerPath} to ${uid}:${uid}`);

	// Return the HOST path for bind mounting
	const hostDataDir = getHostDataDir();
	if (hostDataDir) {
		return `${hostDataDir}/${SCANNER_CACHE_DIR}/${scannerType}`;
	}

	// Fallback: not running in Docker, use container path as-is
	return containerPath;
}

// Run scanner in a fresh container with volume-cached database
async function runScannerContainer(
	scannerImage: string,
	scannerType: 'grype' | 'trivy',
	imageName: string,
	cmd: string[],
	envId?: number,
	onOutput?: (line: string) => void
): Promise<string> {
	// Check if a scan for this exact image is already in progress
	// This prevents duplicate scans when multiple containers use the same image
	const scanKey = `${scannerType}:${imageName}:${envId ?? 'local'}`;
	const existingScan = inProgressScans.get(scanKey);
	if (existingScan) {
		console.log(`[Scanner] Reusing in-progress ${scannerType} scan for: ${imageName}`);
		return existingScan;
	}

	// Create the actual scan promise
	const scanPromise = runScannerContainerImpl(scannerImage, scannerType, imageName, cmd, envId, onOutput);

	// Register it so concurrent requests can reuse it
	inProgressScans.set(scanKey, scanPromise);

	try {
		return await scanPromise;
	} finally {
		// Clean up the tracking entry when done
		inProgressScans.delete(scanKey);
	}
}

// Internal implementation of scanner container run
async function runScannerContainerImpl(
	scannerImage: string,
	scannerType: 'grype' | 'trivy',
	imageName: string,
	cmd: string[],
	envId?: number,
	onOutput?: (line: string) => void
): Promise<string> {
	// Serialize scans of the same type to avoid DB lock conflicts and re-downloads
	return withScannerLock(scannerType, () =>
		runScannerContainerCore(scannerImage, scannerType, imageName, cmd, envId, onOutput)
	);
}

async function runScannerContainerCore(
	scannerImage: string,
	scannerType: 'grype' | 'trivy',
	imageName: string,
	cmd: string[],
	envId?: number,
	onOutput?: (line: string) => void
): Promise<string> {
	console.log(`[Scanner] Starting ${scannerType} scan for image: ${imageName}, envId: ${envId ?? 'local'}`);

	// Always use the base cache path — serial lock prevents concurrent conflicts
	const basePath = scannerType === 'grype' ? '/cache/grype' : '/cache/trivy';
	const dbPath = basePath;

	// Detect the host Docker socket path based on connection type
	// For local socket environments, detect the actual host socket path (handles rootless Docker)
	// For remote environments (hawser/direct with host), scanner runs remotely and uses standard path
	const env = envId ? await getEnvironment(envId) : undefined;
	const connectionType = env?.connectionType;

	// Determine if this is a local socket environment:
	// - connectionType === 'socket' (explicit)
	// - connectionType is null/undefined (default behavior)
	// - connectionType === 'direct' but no host specified (legacy local environments)
	const isLocalSocket = !connectionType ||
		connectionType === 'socket' ||
		(connectionType === 'direct' && !env?.host);

	let hostSocketPath: string;
	let rootlessUid: string | undefined;

	if (isLocalSocket) {
		// Local socket environment - detect host socket path (handles rootless Docker)
		hostSocketPath = getHostDockerSocket();
		console.log(`[Scanner] Local socket scan (${connectionType || 'default'}) - detected host Docker socket: ${hostSocketPath}`);

		// For user-specific Docker sockets (rootless Docker), detect UID for cache ownership
		// but do NOT set container user — in rootless Docker, root inside the container
		// maps to the socket-owning UID on the host via user namespace remapping
		const uid = extractUidFromSocketPath(hostSocketPath);
		if (uid) {
			rootlessUid = uid;
			console.log(`[Scanner] Rootless Docker detected (UID ${rootlessUid})`);
			console.log(`[Scanner] Scanner will run as root inside container (maps to UID ${rootlessUid} on host via user namespace)`);
		}
	} else {
		// Remote environment (direct with host/hawser-standard/hawser-edge)
		// Scanner runs on remote host, uses remote host's standard Docker socket
		hostSocketPath = '/var/run/docker.sock';
		console.log(`[Scanner] Remote scan (${connectionType}, host: ${env?.host}) - using standard socket path: ${hostSocketPath}`);
	}

	// Determine cache storage strategy based on environment
	// For rootless Docker: use bind mount from data directory with correct ownership
	// For standard Docker: use named volume (root-owned is fine when running as root)
	let cacheBind: string;
	const volumeName = scannerType === 'grype' ? GRYPE_VOLUME_NAME : TRIVY_VOLUME_NAME;

	if (rootlessUid) {
		// Rootless Docker: use bind mount from data directory with correct ownership
		const hostCachePath = await ensureScannerCacheDir(scannerType, rootlessUid);
		cacheBind = `${hostCachePath}:${basePath}`;
		console.log(`[Scanner] Rootless mode - using bind mount: ${cacheBind}`);
	} else {
		// Standard Docker: use named volume (root-owned is fine when running as root)
		await ensureVolume(volumeName, envId);
		cacheBind = `${volumeName}:${basePath}`;
		console.log(`[Scanner] Standard mode - using volume: ${volumeName}`);
	}

	const binds = [
		`${hostSocketPath}:/var/run/docker.sock:ro`,
		cacheBind
	];

	console.log(`[Scanner] Container bind mounts: ${JSON.stringify(binds)}`);

	// Environment variables to ensure scanners use the correct cache path
	const envVars = scannerType === 'grype'
		? [`GRYPE_DB_CACHE_DIR=${dbPath}`]
		: [`TRIVY_CACHE_DIR=${dbPath}`];

	console.log(`[Scanner] Running ${scannerType} with cache mounted at ${basePath}`);
	console.log(`[Scanner] Container command: ${cmd.join(' ')}`);
	// Run the scanner container with a 10-minute timeout to prevent indefinite hangs
	const output = await runContainerWithStreaming({
		image: scannerImage,
		cmd,
		binds,
		env: envVars,
		name: `dockhand-${scannerType}-${Date.now()}`,
		envId,
		timeout: 600_000, // 10 minutes
		onStderr: (data) => {
			// Stream stderr lines for real-time progress output
			const lines = data.split('\n');
			for (const line of lines) {
				if (line.trim()) {
					onOutput?.(line);
				}
			}
		}
	});

	console.log(`[Scanner] ${scannerType} container completed, output length: ${output.length}`);
	if (output.length === 0) {
		console.error(`[Scanner] WARNING: Empty output from ${scannerType} container`);
		console.error(`[Scanner] This may indicate the scanner couldn't access Docker socket`);
		console.error(`[Scanner] Host socket path used: ${hostSocketPath}`);
	} else if (output.length < 100) {
		console.log(`[Scanner] ${scannerType} output preview: ${output}`);
	}

	return output;
}

// Scan image with Grype
export async function scanWithGrype(
	imageName: string,
	envId?: number,
	onProgress?: (progress: ScanProgress) => void
): Promise<ScanResult> {
	const startTime = Date.now();
	const scannerImage = 'anchore/grype:latest';
	const { grypeArgs } = await getScannerSettings(envId);

	onProgress?.({
		stage: 'checking',
		message: 'Checking Grype scanner availability...',
		scanner: 'grype'
	});

	// Ensure scanner image is available
	const available = await ensureScannerImage(scannerImage, envId, onProgress);
	if (!available) {
		throw new Error('Failed to get Grype scanner image. Please ensure Docker can pull images.');
	}

	onProgress?.({
		stage: 'scanning',
		message: `Scanning ${imageName} with Grype...`,
		scanner: 'grype',
		progress: 30
	});

	try {
		// Parse CLI args from settings
		const cmd = parseCliArgs(grypeArgs, imageName);
		const output = await runScannerContainer(
			scannerImage,
			'grype',
			imageName,
			cmd,
			envId,
			(line) => {
				onProgress?.({
					stage: 'scanning',
					message: `Scanning ${imageName} with Grype...`,
					scanner: 'grype',
					progress: 50,
					output: line
				});
			}
		);

		// Defensive logging for empty output
		console.log(`[Grype] Scanner container output received, length: ${output.length}`);
		if (output.length === 0) {
			console.error('[Grype] WARNING: Empty output from scanner container - possible race condition');
		}

		onProgress?.({
			stage: 'parsing',
			message: 'Parsing scan results...',
			scanner: 'grype',
			progress: 80
		});

		const { vulnerabilities, summary } = parseGrypeOutput(output);

		// Get the actual SHA256 image ID for reliable caching
		const imageId = await getImageSha(imageName, envId);

		const result: ScanResult = {
			imageId,
			imageName,
			scanner: 'grype',
			scannedAt: new Date().toISOString(),
			vulnerabilities,
			summary,
			scanDuration: Date.now() - startTime
		};

		onProgress?.({
			stage: 'complete',
			message: 'Grype scan complete',
			scanner: 'grype',
			progress: 100,
			result
		});

		return result;
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		onProgress?.({
			stage: 'error',
			message: `Grype scan failed: ${errorMsg}`,
			scanner: 'grype',
			error: errorMsg
		});
		throw error;
	}
}

// Scan image with Trivy
export async function scanWithTrivy(
	imageName: string,
	envId?: number,
	onProgress?: (progress: ScanProgress) => void
): Promise<ScanResult> {
	const startTime = Date.now();
	const scannerImage = 'aquasec/trivy:latest';
	const { trivyArgs } = await getScannerSettings(envId);

	onProgress?.({
		stage: 'checking',
		message: 'Checking Trivy scanner availability...',
		scanner: 'trivy'
	});

	// Ensure scanner image is available
	const available = await ensureScannerImage(scannerImage, envId, onProgress);
	if (!available) {
		throw new Error('Failed to get Trivy scanner image. Please ensure Docker can pull images.');
	}

	onProgress?.({
		stage: 'scanning',
		message: `Scanning ${imageName} with Trivy...`,
		scanner: 'trivy',
		progress: 30
	});

	try {
		// Parse CLI args from settings
		const cmd = parseCliArgs(trivyArgs, imageName);
		const output = await runScannerContainer(
			scannerImage,
			'trivy',
			imageName,
			cmd,
			envId,
			(line) => {
				onProgress?.({
					stage: 'scanning',
					message: `Scanning ${imageName} with Trivy...`,
					scanner: 'trivy',
					progress: 50,
					output: line
				});
			}
		);

		// Defensive logging for empty output
		console.log(`[Trivy] Scanner container output received, length: ${output.length}`);
		if (output.length === 0) {
			console.error('[Trivy] WARNING: Empty output from scanner container - possible race condition');
		}

		onProgress?.({
			stage: 'parsing',
			message: 'Parsing scan results...',
			scanner: 'trivy',
			progress: 80
		});

		const { vulnerabilities, summary } = parseTrivyOutput(output);

		// Get the actual SHA256 image ID for reliable caching
		const imageId = await getImageSha(imageName, envId);

		const result: ScanResult = {
			imageId,
			imageName,
			scanner: 'trivy',
			scannedAt: new Date().toISOString(),
			vulnerabilities,
			summary,
			scanDuration: Date.now() - startTime
		};

		onProgress?.({
			stage: 'complete',
			message: 'Trivy scan complete',
			scanner: 'trivy',
			progress: 100,
			result
		});

		return result;
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		onProgress?.({
			stage: 'error',
			message: `Trivy scan failed: ${errorMsg}`,
			scanner: 'trivy',
			error: errorMsg
		});
		throw error;
	}
}

// Scan image with configured scanner(s)
export async function scanImage(
	imageName: string,
	envId?: number,
	onProgress?: (progress: ScanProgress) => void,
	forceScannerType?: ScannerType
): Promise<ScanResult[]> {
	const { scanner } = await getScannerSettings(envId);
	const scannerType = forceScannerType || scanner;

	if (scannerType === 'none') {
		return [];
	}

	const results: ScanResult[] = [];

	const errors: Error[] = [];

	if (scannerType === 'grype' || scannerType === 'both') {
		try {
			const result = await scanWithGrype(imageName, envId, onProgress);
			results.push(result);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			console.error('[Grype] Scan failed:', errorMsg);
			errors.push(error instanceof Error ? error : new Error(String(error)));
			if (scannerType === 'grype') throw error;
		}
	}

	if (scannerType === 'trivy' || scannerType === 'both') {
		try {
			const result = await scanWithTrivy(imageName, envId, onProgress);
			results.push(result);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			console.error('[Trivy] Scan failed:', errorMsg);
			errors.push(error instanceof Error ? error : new Error(String(error)));
			if (scannerType === 'trivy') throw error;
		}
	}

	// If using 'both' and all scanners failed, throw an error
	if (scannerType === 'both' && results.length === 0 && errors.length > 0) {
		throw new Error(`All scanners failed: ${errors.map(e => e.message).join('; ')}`);
	}

	// Send vulnerability notifications based on combined results
	// When using 'both' scanners, take the MAX of each severity across all results
	if (results.length > 0) {
		const combinedSummary: VulnerabilitySeverity = {
			critical: Math.max(...results.map(r => r.summary.critical)),
			high: Math.max(...results.map(r => r.summary.high)),
			medium: Math.max(...results.map(r => r.summary.medium)),
			low: Math.max(...results.map(r => r.summary.low)),
			negligible: Math.max(...results.map(r => r.summary.negligible)),
			unknown: Math.max(...results.map(r => r.summary.unknown))
		};

		// Send notifications (async, don't block return)
		sendVulnerabilityNotifications(imageName, combinedSummary, envId).catch(err => {
			const errorMsg = err instanceof Error ? err.message : String(err);
			console.error('[Scanner] Failed to send vulnerability notifications:', errorMsg);
		});
	}

	return results;
}

// Check if scanner images are available
export async function checkScannerAvailability(envId?: number): Promise<{
	grype: boolean;
	trivy: boolean;
}> {
	const [grypeAvailable, trivyAvailable] = await Promise.all([
		isScannerImageAvailable('anchore/grype', envId),
		isScannerImageAvailable('aquasec/trivy', envId)
	]);

	return {
		grype: grypeAvailable,
		trivy: trivyAvailable
	};
}

// Get scanner version by running a temporary container
async function getScannerVersion(
	scannerType: 'grype' | 'trivy',
	envId?: number
): Promise<string | null> {
	try {
		const scannerImage = scannerType === 'grype' ? 'anchore/grype:latest' : 'aquasec/trivy:latest';

		// Check if image exists first
		const images = await listImages(envId);
		const hasImage = images.some((img) =>
			img.tags?.some((tag: string) => tag.includes(scannerImage.split(':')[0]))
		);
		if (!hasImage) return null;

		// Create temporary container to get version
		const versionCmd = scannerType === 'grype' ? ['version'] : ['--version'];
		console.log(`[Scanner] Getting ${scannerType} version with cmd:`, versionCmd);
		const { stdout, stderr } = await runContainer({
			image: scannerImage,
			cmd: versionCmd,
			name: `dockhand-${scannerType}-version-${Date.now()}`,
			envId
		});

		console.log(`[Scanner] ${scannerType} version check result: stdout="${stdout.substring(0, 100)}", stderr="${stderr.substring(0, 100)}"`);
		const output = stdout || stderr;

		// Parse version from output
		// Grype: "grype 0.74.0" or "Application:    grype\nVersion:    0.86.1"
		// Trivy: "Version: 0.48.0" or just "0.48.0"
		const versionMatch = output.match(/(?:grype|trivy|Version:?\s*)?([\d]+\.[\d]+\.[\d]+)/i);
		const version = versionMatch ? versionMatch[1] : null;

		if (!version) {
			console.error(`Could not parse ${scannerType} version from output:`, output.substring(0, 200));
		}

		return version;
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error(`[Scanner] Failed to get ${scannerType} version:`, errorMsg);
		return null;
	}
}

// Get versions of available scanners
export async function getScannerVersions(envId?: number): Promise<{
	grype: string | null;
	trivy: string | null;
}> {
	const [grypeVersion, trivyVersion] = await Promise.all([
		getScannerVersion('grype', envId),
		getScannerVersion('trivy', envId)
	]);

	return {
		grype: grypeVersion,
		trivy: trivyVersion
	};
}

// Check if scanner images have updates available by comparing local digest with remote
export async function checkScannerUpdates(envId?: number): Promise<{
	grype: { hasUpdate: boolean; localDigest?: string; remoteDigest?: string };
	trivy: { hasUpdate: boolean; localDigest?: string; remoteDigest?: string };
}> {
	const result = {
		grype: { hasUpdate: false, localDigest: undefined as string | undefined, remoteDigest: undefined as string | undefined },
		trivy: { hasUpdate: false, localDigest: undefined as string | undefined, remoteDigest: undefined as string | undefined }
	};

	try {
		const images = await listImages(envId);

		// Check both scanners
		for (const [scanner, imageName] of [['grype', 'anchore/grype:latest'], ['trivy', 'aquasec/trivy:latest']] as const) {
			try {
				// Find local image
				const localImage = images.find((img) =>
					img.tags?.includes(imageName)
				);

				if (localImage && localImage.id) {
					const updateResult = await checkImageUpdateAvailable(imageName, localImage.id, envId);
					result[scanner].hasUpdate = updateResult.hasUpdate;
					result[scanner].localDigest = updateResult.currentDigest;
					result[scanner].remoteDigest = updateResult.registryDigest;
				}
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				console.error(`[Scanner] Failed to check updates for ${scanner}:`, errorMsg);
			}
		}
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error('[Scanner] Failed to check scanner updates:', errorMsg);
	}

	return result;
}

// Clean up scanner database volumes (removes cached vulnerability databases)
export async function cleanupScannerVolumes(envId?: number): Promise<void> {
	try {
		// Remove scanner database volumes
		for (const volumeName of [GRYPE_VOLUME_NAME, TRIVY_VOLUME_NAME]) {
			try {
				await removeVolume(volumeName, true, envId);
				console.log(`[Scanner] Removed volume: ${volumeName}`);
			} catch {
				// Volume might not exist, ignore
			}
		}
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error('[Scanner] Failed to cleanup scanner volumes:', errorMsg);
	}
}
