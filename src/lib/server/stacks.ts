/**
 * Stack Management Module
 *
 * Provides compose-first stack operations for internal, git, and external stacks.
 * All lifecycle operations use docker compose commands.
 */

import { existsSync, mkdirSync, rmSync, readdirSync, cpSync, statSync, unlinkSync, renameSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import {
	getEnvironment,
	getSecretEnvVarsAsRecord,
	getNonSecretEnvVarsAsRecord,
	getStackEnvVars,
	setStackEnvVars,
	getStackSource,
	upsertStackSource,
	deleteStackSource,
	getGitStackByName,
	deleteGitStack,
	getStackSources,
	deleteStackEnvVars,
	removePendingContainerUpdate,
	deleteAutoUpdateSchedule,
	getAutoUpdateSetting,
	getStackSourceByComposePath
} from './db';
import { unregisterSchedule } from './scheduler';
import { deleteGitStackFiles, parseEnvFileContent } from './git';
import { cleanPem } from '$lib/utils/pem';
import { rewriteComposeVolumePaths, getHostDataDir } from './host-path';

// =============================================================================
// TYPES
// =============================================================================

/**
 * TLS configuration for remote Docker connections
 */
interface TlsConfig {
	ca?: string;
	cert?: string;
	key?: string;
	skipVerify?: boolean;
}

/**
 * Stack source types
 */
export type StackSourceType = 'internal' | 'git' | 'external';

/**
 * Stack operation result
 */
export interface StackOperationResult {
	success: boolean;
	output?: string;
	error?: string;
}

/**
 * Container detail within a stack
 */
export interface ContainerDetail {
	id: string;
	name: string;
	service: string;
	state: string;
	status: string;
	health?: string;
	image: string;
	ports: Array<{ publicPort: number; privatePort: number; type: string; display: string }>;
	networks: Array<{ name: string; ipAddress: string }>;
	volumeCount: number;
	restartCount: number;
	created: number;
}

/**
 * Compose stack information
 */
export interface ComposeStackInfo {
	name: string;
	containers: string[];
	containerDetails: ContainerDetail[];
	status: 'running' | 'stopped' | 'partial' | 'created';
	sourceType?: StackSourceType;
	hasComposeFile?: boolean;
}

/**
 * Stack deployment options
 */
export interface DeployStackOptions {
	name: string;
	compose: string;
	envId?: number | null;
	sourceDir?: string; // Directory to copy all files from (for git stacks)
	forceRecreate?: boolean;
	composePath?: string; // Custom compose file path (for adopted/imported stacks)
	envPath?: string; // Custom env file path (for adopted/imported stacks)
	composeFileName?: string; // Compose filename to use (e.g., "docker-compose.yaml") for git stacks
	envFileName?: string; // Env filename relative to compose dir (e.g., ".env") for git stacks
}

// =============================================================================
// ERRORS
// =============================================================================

/**
 * Error when compose file is missing for a managed stack
 */
export class ComposeFileNotFoundError extends Error {
	public readonly stackName: string;

	constructor(stackName: string) {
		super(
			`Compose file not found for stack "${stackName}". ` +
				`The stack may have been deleted or was created outside of Dockhand.`
		);
		this.name = 'ComposeFileNotFoundError';
		this.stackName = stackName;
	}
}

// =============================================================================
// INTERNAL STATE
// =============================================================================

// Cache stacks directory
let _stacksDir: string | null = null;

// Per-stack locking mechanism to prevent race conditions during concurrent operations
const stackLocks = new Map<string, Promise<void>>();

// Track active TLS temp directories for cleanup on unexpected process exit
const activeTlsDirs = new Set<string>();

// Register cleanup handlers once at module load
if (typeof process !== 'undefined') {
	const cleanupTlsDirs = () => {
		for (const dir of activeTlsDirs) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch { /* ignore */ }
		}
		activeTlsDirs.clear();
	};
	process.on('exit', cleanupTlsDirs);
	process.on('SIGINT', () => { cleanupTlsDirs(); process.exit(130); });
	process.on('SIGTERM', () => { cleanupTlsDirs(); process.exit(143); });
}

/**
 * Execute a function with exclusive lock on a stack.
 * Prevents race conditions when multiple operations target the same stack.
 */
async function withStackLock<T>(stackName: string, fn: () => Promise<T>): Promise<T> {
	const lockKey = stackName;

	// Wait for any existing lock to release
	while (stackLocks.has(lockKey)) {
		await stackLocks.get(lockKey);
	}

	// Create new lock
	let releaseLock: () => void;
	const lockPromise = new Promise<void>((resolve) => {
		releaseLock = resolve;
	});
	stackLocks.set(lockKey, lockPromise);

	try {
		return await fn();
	} finally {
		stackLocks.delete(lockKey);
		releaseLock!();
	}
}

// Timeout configuration for compose operations
const COMPOSE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const COMPOSE_KILL_GRACE_MS = 5000; // 5 seconds grace period before SIGKILL

/**
 * Read all files from a directory as a map of relative path -> content.
 * Used to send files to Hawser for remote deployments.
 */
async function readDirFilesAsMap(dirPath: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {};

	async function scanDir(currentPath: string, relativePath: string = ''): Promise<void> {
		const entries = readdirSync(currentPath, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(currentPath, entry.name);
			const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

			if (entry.isDirectory()) {
				// Skip .git directory
				if (entry.name === '.git') continue;
				await scanDir(fullPath, relPath);
			} else if (entry.isFile()) {
				// Read file content
				const content = await Bun.file(fullPath).text();
				files[relPath] = content;
			}
		}
	}

	await scanDir(dirPath);
	return files;
}

// =============================================================================
// DEBUG UTILITIES
// =============================================================================

/**
 * Mask sensitive values in environment variables for safe logging.
 * Masks values for keys containing common secret patterns and truncates long values.
 */
function maskSecrets(vars: Record<string, string>): Record<string, string> {
	const masked: Record<string, string> = {};
	const secretPatterns = /password|secret|token|key|api_key|apikey|auth|credential|private/i;
	for (const [key, value] of Object.entries(vars)) {
		if (secretPatterns.test(key)) {
			masked[key] = '***';
		} else if (value.length > 50) {
			// Truncate long values that might be secrets
			masked[key] = value.substring(0, 10) + '...(truncated)';
		} else {
			masked[key] = value;
		}
	}
	return masked;
}

// =============================================================================
// UTILITIES
// =============================================================================

/**
 * Get the compose stacks directory (always returns absolute path)
 */
export function getStacksDir(): string {
	if (_stacksDir) return _stacksDir;
	const dataDir = process.env.DATA_DIR || './data';
	// Resolve to absolute path to avoid issues with relative paths in docker compose
	_stacksDir = resolve(join(dataDir, 'stacks'));
	if (!existsSync(_stacksDir)) {
		mkdirSync(_stacksDir, { recursive: true });
	}
	return _stacksDir;
}

/**
 * Get stack directory path for a specific environment.
 * New stacks use: $DATA_DIR/stacks/<envName>/<stackName>/
 * Legacy stacks (no env): $DATA_DIR/stacks/<stackName>/
 *
 * Automatically looks up environment name from database.
 */
export async function getStackDir(stackName: string, envId?: number | null): Promise<string> {
	const stacksDir = getStacksDir();
	if (envId) {
		const env = await getEnvironment(envId);
		if (env) {
			return join(stacksDir, env.name, stackName);
		}
	}
	// Legacy path for stacks without environment
	return join(stacksDir, stackName);
}

/**
 * Find stack directory, checking paths in order:
 * 1. Database: Custom composePath in stackSources table (adopted/imported stacks)
 * 2. New path (envName): $DATA_DIR/stacks/<envName>/<stackName>/
 * 3. ID-based path (envId): $DATA_DIR/stacks/<envId>/<stackName>/
 * 4. Legacy path: $DATA_DIR/stacks/<stackName>/
 *
 * Automatically looks up environment name from database.
 * Always checks legacy path for backwards compatibility with pre-env stacks.
 */
export async function findStackDir(stackName: string, envId?: number | null): Promise<string | null> {
	// 1. Check database for custom compose path first (adopted/imported stacks)
	const source = await getStackSource(stackName, envId);
	if (source?.composePath) {
		const customDir = dirname(source.composePath);
		if (existsSync(customDir)) {
			return customDir;
		}
	}

	const stacksDir = getStacksDir();

	// Look up environment name if we have an ID
	if (envId) {
		const env = await getEnvironment(envId);

		// 2. Check new path (with envName)
		if (env) {
			const namePath = join(stacksDir, env.name, stackName);
			if (existsSync(namePath)) {
				return namePath;
			}
		}

		// 3. Check ID-based path
		const idPath = join(stacksDir, String(envId), stackName);
		if (existsSync(idPath)) {
			return idPath;
		}
	}

	// 4. Always check legacy path (stacks created before env-scoping was added)
	const legacyPath = join(stacksDir, stackName);
	if (existsSync(legacyPath)) {
		return legacyPath;
	}

	return null;
}

// =============================================================================
// COMPOSE FILE MANAGEMENT
// =============================================================================

/**
 * Result type for getStackComposeFile
 */
export interface GetComposeFileResult {
	success: boolean;
	content?: string;
	stackDir?: string;
	error?: string;
	needsFileLocation?: boolean;
	composePath?: string | null;
	envPath?: string | null;
	suggestedEnvPath?: string;
}

/**
 * Get compose file content for a stack.
 *
 * Unified logic for all stacks:
 * - If composePath is set in DB → use custom path
 * - If composePath is NULL → use default location (data/stacks/{env}/{name}/)
 * - If no source record and no files found → return needsFileLocation: true
 */
export async function getStackComposeFile(
	stackName: string,
	envId?: number | null,
	composeConfigPath?: string
): Promise<GetComposeFileResult> {
	let source = await getStackSource(stackName, envId);

	// Fallback: try lookup by compose file path from Docker labels
	if (!source && composeConfigPath) {
		source = await getStackSourceByComposePath(composeConfigPath, envId);
	}

	// Case 1: Stack not in database = untracked (discovered from Docker but not imported)
	// User must select the compose file location - don't guess from default location
	if (!source) {
		return {
			success: false,
			needsFileLocation: true,
			error: `Select the compose file location for stack "${stackName}"`
		};
	}

	// Case 2: Stack has custom composePath set - use it
	if (source.composePath) {
		try {
			if (!existsSync(source.composePath)) {
				return {
					success: false,
					error: `Compose file no longer accessible at ${source.composePath}. The file may have been moved or deleted.`,
					composePath: source.composePath,
					envPath: source.envPath
				};
			}

			const content = await Bun.file(source.composePath).text();
			const stackDir = dirname(source.composePath);

			// For custom paths, suggest .env next to compose if envPath not set
			let suggestedEnvPath: string | undefined;
			if (source.envPath === null) {
				suggestedEnvPath = source.composePath.replace(/\/[^/]+$/, '/.env');
			}

			return {
				success: true,
				content,
				stackDir,
				composePath: source.composePath,
				envPath: source.envPath,
				suggestedEnvPath
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			return {
				success: false,
				error: `Failed to read compose file: ${message}`,
				composePath: source.composePath,
				envPath: source.envPath
			};
		}
	}

	// Case 3: Stack is in DB but no custom path - check default location
	// This is for stacks created in Dockhand using the default data directory
	const stackDir = await findStackDir(stackName, envId);

	if (stackDir) {
		// Check all common compose file names (prefer new style first)
		const composeFileNames = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];

		for (const fileName of composeFileNames) {
			const actualComposePath = join(stackDir, fileName);
			const file = Bun.file(actualComposePath);
			if (await file.exists()) {
				// Check for .env file in the same directory
				const envFilePath = join(stackDir, '.env');
				const envExists = existsSync(envFilePath);

				return {
					success: true,
					content: await file.text(),
					stackDir,
					// Always return the actual resolved paths for display
					composePath: actualComposePath,
					envPath: envExists ? envFilePath : null
				};
			}
		}
	}

	// Case 4: Stack is in DB but compose file not found - need user to specify location
	return {
		success: false,
		needsFileLocation: true,
		error: `Select the compose file location for stack "${stackName}"`
	};
}

/**
 * Save or create a stack compose file without deploying.
 * @param name - Stack name
 * @param content - Compose file content
 * @param create - If true, creates a new stack (fails if exists). If false, updates existing (fails if not exists).
 * @param envId - Environment ID for path scoping
 */
export async function saveStackComposeFile(
	name: string,
	content: string,
	create = false,
	envId?: number | null,
	options?: {
		composePath?: string;  // Custom compose file path
		envPath?: string | null;  // Custom env path (null = default, '' = none)
		moveFromDir?: string;  // Old directory to move all files from when path changes
		oldComposePath?: string;  // Old compose file path for renaming
		oldEnvPath?: string;  // Old env file path for renaming
	}
): Promise<{ success: boolean; error?: string }> {
	// Validate stack name - Docker Compose requires lowercase alphanumeric, hyphens, underscores
	// Must also start with a letter or number
	if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
		return {
			success: false,
			error: 'Stack name must be lowercase, start with a letter or number, and contain only letters, numbers, hyphens, and underscores'
		};
	}

	// Check if this stack has a custom compose path configured, or if one was provided
	const source = await getStackSource(name, envId);
	const composePath = options?.composePath || source?.composePath;

	// Handle compose file move/rename when path changes
	if (options?.oldComposePath && options?.composePath &&
		options.oldComposePath !== options.composePath &&
		existsSync(options.oldComposePath)) {
		const newDir = dirname(options.composePath);

		// Ensure target directory exists
		if (!existsSync(newDir)) {
			try {
				mkdirSync(newDir, { recursive: true });
			} catch (err: any) {
				console.warn(`[Stack] Failed to create directory ${newDir}: ${err.message}`);
			}
		}

		// Move/rename the compose file to new location
		try {
			renameSync(options.oldComposePath, options.composePath);
			console.log(`[Stack] Moved compose file: ${options.oldComposePath} -> ${options.composePath}`);
		} catch (renameErr: any) {
			// If rename fails (e.g., cross-filesystem), try copy+delete
			if (renameErr.code === 'EXDEV') {
				try {
					const data = readFileSync(options.oldComposePath);
					writeFileSync(options.composePath, data);
					unlinkSync(options.oldComposePath);
					console.log(`[Stack] Copied compose file (cross-fs): ${options.oldComposePath} -> ${options.composePath}`);
				} catch (err: any) {
					console.warn(`[Stack] Failed to copy compose file: ${err.message}`);
				}
			} else {
				console.warn(`[Stack] Failed to move compose file: ${renameErr.message}`);
			}
		}
	}

	// Handle env file move/rename when path changes
	if (options?.oldEnvPath && options?.envPath &&
		options.oldEnvPath !== options.envPath &&
		existsSync(options.oldEnvPath)) {
		const newDir = dirname(options.envPath);

		// Ensure target directory exists
		if (!existsSync(newDir)) {
			try {
				mkdirSync(newDir, { recursive: true });
			} catch (err: any) {
				console.warn(`[Stack] Failed to create directory ${newDir}: ${err.message}`);
			}
		}

		// Move/rename the env file to new location
		try {
			renameSync(options.oldEnvPath, options.envPath);
			console.log(`[Stack] Moved env file: ${options.oldEnvPath} -> ${options.envPath}`);
		} catch (renameErr: any) {
			// If rename fails (e.g., cross-filesystem), try copy+delete
			if (renameErr.code === 'EXDEV') {
				try {
					const data = readFileSync(options.oldEnvPath);
					writeFileSync(options.envPath, data);
					unlinkSync(options.oldEnvPath);
					console.log(`[Stack] Copied env file (cross-fs): ${options.oldEnvPath} -> ${options.envPath}`);
				} catch (err: any) {
					console.warn(`[Stack] Failed to copy env file: ${err.message}`);
				}
			} else {
				console.warn(`[Stack] Failed to move env file: ${renameErr.message}`);
			}
		}
	}

	// Move all files from old directory to new directory when path changes
	// Get the new directory from composePath
	const newDir = options?.composePath ? dirname(options.composePath) : null;

	if (options?.moveFromDir && newDir && options.moveFromDir !== newDir && existsSync(options.moveFromDir)) {
		try {
			// Ensure new directory exists
			if (!existsSync(newDir)) {
				mkdirSync(newDir, { recursive: true });
			}

			// Move all files from old directory to new directory
			const files = readdirSync(options.moveFromDir);
			for (const file of files) {
				const oldFilePath = join(options.moveFromDir, file);
				const newFilePath = join(newDir, file);

				try {
					// Use rename for atomic move (same filesystem) or copy+delete for cross-filesystem
					renameSync(oldFilePath, newFilePath);
					console.log(`[Stack] Moved file: ${oldFilePath} -> ${newFilePath}`);
				} catch (renameErr: any) {
					// If rename fails (e.g., cross-filesystem), try copy+delete
					if (renameErr.code === 'EXDEV') {
						const stat = statSync(oldFilePath);
						if (stat.isDirectory()) {
							// For directories, use recursive copy
							cpSync(oldFilePath, newFilePath, { recursive: true });
							rmSync(oldFilePath, { recursive: true, force: true });
						} else {
							// For files, read and write
							const data = readFileSync(oldFilePath);
							writeFileSync(newFilePath, data);
							unlinkSync(oldFilePath);
						}
						console.log(`[Stack] Copied file (cross-fs): ${oldFilePath} -> ${newFilePath}`);
					} else {
						throw renameErr;
					}
				}
			}

			// Remove old directory if it's now empty
			try {
				const remaining = readdirSync(options.moveFromDir);
				if (remaining.length === 0) {
					rmSync(options.moveFromDir, { recursive: true, force: true });
					console.log(`[Stack] Removed empty old directory: ${options.moveFromDir}`);
				}
			} catch {
				// Ignore errors when checking/removing old directory
			}
		} catch (err: any) {
			console.warn(`[Stack] Failed to move files from ${options.moveFromDir} to ${newDir}: ${err.message}`);
			// Continue with save even if move fails - new files will be written anyway
		}
	}

	// If a custom composePath is being set (new or update), save it to the database
	if (options?.composePath || options?.envPath !== undefined) {
		await upsertStackSource({
			stackName: name,
			environmentId: envId ?? null,
			sourceType: 'internal',
			composePath: options?.composePath || source?.composePath || null,
			envPath: options?.envPath !== undefined ? options.envPath : (source?.envPath ?? null)
		});
	}

	if (composePath) {
		// Write directly to the custom compose file path
		// Ensure parent directory exists for custom paths
		const parentDir = dirname(composePath);
		if (!existsSync(parentDir)) {
			try {
				mkdirSync(parentDir, { recursive: true });
			} catch (err: any) {
				return { success: false, error: `Failed to create directory for compose file: ${err.message}` };
			}
		}
		try {
			await Bun.write(composePath, content);
			return { success: true };
		} catch (err: any) {
			return { success: false, error: `Failed to save compose file: ${err.message}` };
		}
	}

	// For creates, use new path; for updates, find existing path first
	let stackDir: string;
	if (create) {
		stackDir = await getStackDir(name, envId);
	} else {
		const existingDir = await findStackDir(name, envId);
		if (!existingDir) {
			return { success: false, error: `Stack "${name}" not found` };
		}
		stackDir = existingDir;
	}

	const composeFile = join(stackDir, 'compose.yaml');
	const exists = existsSync(stackDir);

	if (create) {
		// Creating new stack - if directory exists, it's orphaned (clean it up)
		if (exists) {
			try {
				console.log(`Cleaning up orphaned stack directory: ${stackDir}`);
				rmSync(stackDir, { recursive: true, force: true });
			} catch (err: any) {
				return { success: false, error: `Stack directory exists and cleanup failed: ${err.message}` };
			}
		}
		try {
			mkdirSync(stackDir, { recursive: true });
		} catch (err: any) {
			return { success: false, error: `Failed to create stack directory: ${err.message}` };
		}
	}

	try {
		await Bun.write(composeFile, content);
		return { success: true };
	} catch (err: any) {
		return { success: false, error: `Failed to ${create ? 'create' : 'save'} compose file: ${err.message}` };
	}
}

// =============================================================================
// REGISTRY AUTHENTICATION
// =============================================================================

/**
 * Login to all configured Docker registries before running compose commands.
 * This ensures that `docker compose up` can pull images from private registries.
 */
async function loginToRegistries(dockerHost?: string, logPrefix = '[Stack]'): Promise<void> {
	const { getRegistries } = await import('./db.js');
	const registries = await getRegistries();

	if (registries.length === 0) {
		return;
	}

	const spawnEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
	if (dockerHost) {
		spawnEnv.DOCKER_HOST = dockerHost;
	}

	for (const reg of registries) {
		if (!reg.username || !reg.password) {
			continue; // Skip registries without credentials
		}

		try {
			// Extract registry host from URL
			const url = new URL(reg.url);
			const registryHost = url.host;

			console.log(`${logPrefix} Logging into registry: ${registryHost}`);

			const proc = Bun.spawn(
				['docker', 'login', '-u', reg.username, '--password-stdin', registryHost],
				{
					env: spawnEnv,
					stdin: 'pipe',
					stdout: 'pipe',
					stderr: 'pipe'
				}
			);

			// Write password to stdin (Bun's FileSink API)
			proc.stdin.write(reg.password);
			proc.stdin.end();

			const exitCode = await proc.exited;

			if (exitCode === 0) {
				console.log(`${logPrefix} Successfully logged into ${registryHost}`);
			} else {
				const stderr = await new Response(proc.stderr).text();
				console.error(`${logPrefix} Failed to login to ${registryHost}: ${stderr}`);
			}
		} catch (e) {
			const errorMsg = e instanceof Error ? e.message : String(e);
			console.error(`${logPrefix} Error logging into registry ${reg.name}:`, errorMsg);
		}
	}
}

// =============================================================================
// COMPOSE COMMAND EXECUTION
// =============================================================================

interface ComposeCommandOptions {
	stackName: string;
	envId?: number | null;
	forceRecreate?: boolean;
	removeVolumes?: boolean;
	stackFiles?: Record<string, string>; // All files to send to Hawser
	/** Working directory for compose execution (for imported stacks) */
	workingDir?: string;
	/** Full path to the compose file (for imported stacks, to avoid writing to internal dir) */
	composePath?: string;
	/** Full path to the env file (for --env-file flag, supports custom names) */
	envPath?: string;
	/** When true, write non-secret envVars to .env.dockhand override file (git stacks only) */
	useOverrideFile?: boolean;
	/** Target specific service only (with --no-deps) for single-service updates */
	serviceName?: string;
	/** Compose filename for Hawser (e.g., "docker-compose.prod.yml") - extracted from composePath */
	composeFileName?: string;
}

/**
 * Find a Docker Compose override file alongside the main compose file.
 * Docker Compose auto-discovers these when no -f flag is used, but when -f is required
 * we need to explicitly include the override file.
 */
function findComposeOverrideFile(stackDir: string, composeFileName: string): string | null {
	const overrideMap: Record<string, string[]> = {
		'compose.yaml': ['compose.override.yaml', 'compose.override.yml'],
		'compose.yml': ['compose.override.yaml', 'compose.override.yml'],
		'docker-compose.yaml': ['docker-compose.override.yaml', 'docker-compose.override.yml'],
		'docker-compose.yml': ['docker-compose.override.yaml', 'docker-compose.override.yml'],
	};
	const candidates = overrideMap[composeFileName] || [];
	for (const name of candidates) {
		const fullPath = join(stackDir, name);
		if (existsSync(fullPath)) return fullPath;
	}
	return null;
}

/**
 * Execute a docker compose command locally via Bun.spawn.
 *
 * @param tlsConfig - TLS configuration for remote Docker connections (certs written to temp files)
 * @param envVars - Non-secret environment variables (from .env file, passed for backward compat)
 * @param secretVars - Secret environment variables (injected via shell env, NEVER written to disk)
 * @param workingDir - Optional working directory for compose execution (for imported stacks)
 * @param customComposePath - Optional path to existing compose file (for imported stacks, skips writing)
 */
async function executeLocalCompose(
	operation: 'up' | 'down' | 'stop' | 'start' | 'restart' | 'pull',
	stackName: string,
	composeContent: string,
	dockerHost?: string,
	tlsConfig?: TlsConfig,
	envVars?: Record<string, string>,
	secretVars?: Record<string, string>,
	forceRecreate?: boolean,
	removeVolumes?: boolean,
	envId?: number | null,
	workingDir?: string,
	customComposePath?: string,
	customEnvPath?: string,
	useOverrideFile?: boolean,
	serviceName?: string
): Promise<StackOperationResult> {
	const logPrefix = `[Stack:${stackName}]`;

	// Determine working directory and compose file path
	// For imported stacks (custom paths), use the provided workingDir and composePath
	// For internal stacks, use the default data directory
	let stackDir: string;
	let composeFile: string;

	if (customComposePath && workingDir) {
		// Custom compose path provided - use the provided working directory and compose file
		// This applies to:
		// - Imported/adopted stacks: files exist at original location, no copying needed
		// - Git stacks: files were already copied to workingDir by deployStack(), use them in-place
		// In both cases, we don't write the compose file - it already exists
		stackDir = workingDir;
		composeFile = customComposePath;
	} else {
		// Internal stack: use default data directory
		stackDir = operation === 'up'
			? await getStackDir(stackName, envId)
			: (await findStackDir(stackName, envId) || await getStackDir(stackName, envId));
		mkdirSync(stackDir, { recursive: true });
		composeFile = join(stackDir, 'compose.yaml');
		await Bun.write(composeFile, composeContent);
	}

	// Rewrite relative volume paths for host path translation (in memory only, not saved to disk)
	// This is needed when Dockhand runs inside Docker - the Docker daemon on the host
	// can't see container paths like /app/data/..., so we translate them to host paths
	// Only do this for local Docker (no dockerHost) - for remote Docker the paths wouldn't make sense
	let finalComposeContent = composeContent;
	if (!dockerHost && getHostDataDir()) {
		const rewriteResult = rewriteComposeVolumePaths(composeContent, stackDir);
		if (rewriteResult.modified) {
			finalComposeContent = rewriteResult.content;
			console.log(`${logPrefix} [HostPath] Translating relative volume paths for Docker host:`);
			for (const change of rewriteResult.changes) {
				console.log(`${logPrefix} [HostPath]${change}`);
			}
			console.log(`${logPrefix} [HostPath] Translated compose content:`);
			console.log(`${logPrefix} [HostPath] ----------------------------------------`);
			for (const line of finalComposeContent.split('\n')) {
				console.log(`${logPrefix} [HostPath] ${line}`);
			}
			console.log(`${logPrefix} [HostPath] ----------------------------------------`);
		}
	}

	// Build spawn environment with ONLY essential system variables.
	// CRITICAL: Do NOT spread process.env! Docker Compose shell env has higher
	// priority than --env-file, so Dockhand's vars would override user's .env values.
	const spawnEnv: Record<string, string> = {
		PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
		HOME: process.env.HOME || '/root',
	};

	// Docker connection config
	if (dockerHost) {
		spawnEnv.DOCKER_HOST = dockerHost;
	} else if (process.env.DOCKER_HOST) {
		spawnEnv.DOCKER_HOST = process.env.DOCKER_HOST;
	}

	// Check if .env file exists on disk (for legacy support decision)
	const defaultEnvPath = join(stackDir, '.env');
	const hasEnvFile = existsSync(defaultEnvPath) || (customEnvPath && existsSync(customEnvPath));

	// LEGACY SUPPORT: Only inject envVars via shell if NO .env file exists
	// This is for stacks created with older Dockhand versions that stored env vars
	// in DB but didn't write .env files to disk.
	// For modern stacks with .env files, Docker Compose reads them via --env-file.
	if (!hasEnvFile && envVars) {
		Object.assign(spawnEnv, envVars);
	}

	// SECRET vars: always injected via shell env (NEVER written to .env files)
	if (secretVars) {
		Object.assign(spawnEnv, secretVars);
	}

	// Handle TLS certificates for remote Docker connections
	// Docker CLI requires file paths, so we write certs to a temp directory
	let tlsCertDir: string | undefined;

	if (tlsConfig && (tlsConfig.ca || tlsConfig.cert)) {
		// Create temp directory for TLS certs in DATA_DIR (guaranteed writable in Docker)
		// Use resolve() to get absolute path - docker compose runs from a different working dir
		const dataDir = resolve(process.env.DATA_DIR || './data');
		tlsCertDir = join(dataDir, 'tmp', `tls-${stackName}-${Date.now()}`);
		mkdirSync(tlsCertDir, { recursive: true });

		// Track for cleanup on unexpected process exit
		activeTlsDirs.add(tlsCertDir);

		// Write certs to files (docker-compose expects specific filenames)
		if (tlsConfig.ca) {
			const cleanedCa = cleanPem(tlsConfig.ca);
			if (cleanedCa) await Bun.write(join(tlsCertDir, 'ca.pem'), cleanedCa);
		}
		if (tlsConfig.cert) {
			const cleanedCert = cleanPem(tlsConfig.cert);
			if (cleanedCert) await Bun.write(join(tlsCertDir, 'cert.pem'), cleanedCert);
		}
		if (tlsConfig.key) {
			const cleanedKey = cleanPem(tlsConfig.key);
			if (cleanedKey) await Bun.write(join(tlsCertDir, 'key.pem'), cleanedKey);
		}

		// Set Docker TLS environment variables
		spawnEnv.DOCKER_TLS = '1';
		spawnEnv.DOCKER_CERT_PATH = tlsCertDir;
		spawnEnv.DOCKER_TLS_VERIFY = tlsConfig.skipVerify ? '0' : '1';

		console.log(`${logPrefix} TLS enabled: DOCKER_CERT_PATH=${tlsCertDir}, DOCKER_TLS_VERIFY=${spawnEnv.DOCKER_TLS_VERIFY}`);
	}

	// Build command based on operation
	// If we have modified compose content (host path translation), use stdin instead of file
	const useStdin = finalComposeContent !== composeContent;
	const args = ['docker', 'compose', '-p', stackName];

	// Temp file for path-translated override content (cleaned up in finally block)
	let tempOverridePath: string | undefined;

	if (useStdin) {
		// Host path translation: must pipe modified content via stdin
		args.push('-f', '-');
		// Also include override file if it exists (needs path translation too)
		const overrideFile = findComposeOverrideFile(stackDir, basename(composeFile));
		if (overrideFile) {
			let overrideContent = await Bun.file(overrideFile).text();
			if (getHostDataDir()) {
				const rewrite = rewriteComposeVolumePaths(overrideContent, stackDir);
				if (rewrite.modified) overrideContent = rewrite.content;
			}
			tempOverridePath = join(stackDir, '.compose.override.translated.yaml');
			await Bun.write(tempOverridePath, overrideContent);
			args.push('-f', tempOverridePath);
			console.log(`${logPrefix} Including override file (path-translated): ${basename(overrideFile)}`);
		}
	} else if (customComposePath) {
		// Custom path (imported/adopted stacks): must use -f to point to non-standard location
		args.push('-f', composeFile);
		const overrideFile = findComposeOverrideFile(stackDir, basename(composeFile));
		if (overrideFile) {
			args.push('-f', overrideFile);
			console.log(`${logPrefix} Including override file: ${basename(overrideFile)}`);
		}
	}
	// else: internal stack without path translation - no -f needed.
	// Docker Compose auto-discovers compose.yaml + compose.override.yaml from cwd.

	// Always auto-detect .env in compose directory (defaultEnvPath already defined above)
	if (existsSync(defaultEnvPath)) {
		args.push('--env-file', defaultEnvPath);
	}

	// Add custom env file if configured and different from auto-detected .env
	if (customEnvPath && resolve(customEnvPath) !== resolve(defaultEnvPath) && existsSync(customEnvPath)) {
		args.push('--env-file', customEnvPath);
	}

	// For git stacks: write non-secret overrides to .env.dockhand and add as second --env-file
	// Docker Compose applies env files in order, so later files override earlier ones.
	// This lets the repo's .env provide defaults while our overrides take precedence.
	// Secrets are still injected via shell env only (never written to disk).
	// Only written when useOverrideFile is true (git stacks). Internal/adopted stacks
	// already have their non-secrets in the .env file written by the UI.
	if (useOverrideFile && envVars && Object.keys(envVars).length > 0) {
		const overrideEnvPath = join(stackDir, '.env.dockhand');
		const header = '# Auto-generated by Dockhand. Do not edit - changes will be overwritten on next deploy.\n';
		const lines = Object.entries(envVars).map(([k, v]) => `${k}=${v}`);
		await Bun.write(overrideEnvPath, header + lines.join('\n') + '\n');
		args.push('--env-file', overrideEnvPath);
	}

	if (useStdin) {
		console.log(`${logPrefix} [HostPath] Using stdin for compose content (paths translated)`);
	}

	switch (operation) {
		case 'up':
			args.push('up', '-d', '--remove-orphans');
			if (forceRecreate) args.push('--force-recreate');
			// If targeting a specific service, only update that service
			if (serviceName) {
				args.push(serviceName);
			}
			break;
		case 'down':
			args.push('down');
			if (removeVolumes) args.push('--volumes');
			break;
		case 'stop':
			args.push('stop');
			break;
		case 'start':
			args.push('start');
			break;
		case 'restart':
			args.push('restart');
			break;
		case 'pull':
			args.push('pull');
			// If targeting a specific service, pull only that service
			if (serviceName) {
				args.push(serviceName);
			}
			break;
	}

	console.log(`${logPrefix} ----------------------------------------`);
	console.log(`${logPrefix} EXECUTE LOCAL COMPOSE`);
	console.log(`${logPrefix} ----------------------------------------`);
	console.log(`${logPrefix} Operation:`, operation);
	console.log(`${logPrefix} Command:`, args.join(' '));
	console.log(`${logPrefix} Working directory:`, stackDir);
	console.log(`${logPrefix} Compose file:`, composeFile);
	console.log(`${logPrefix} DOCKER_HOST:`, dockerHost || '(local socket)');
	console.log(`${logPrefix} Force recreate:`, forceRecreate ?? false);
	console.log(`${logPrefix} Remove volumes:`, removeVolumes ?? false);
	console.log(`${logPrefix} Service name:`, serviceName ?? '(all services)');
	console.log(`${logPrefix} Env vars count:`, envVars ? Object.keys(envVars).length : 0);
	if (envVars && Object.keys(envVars).length > 0) {
		console.log(`${logPrefix} Env vars being injected (masked):`, JSON.stringify(maskSecrets(envVars), null, 2));
	}

	// Login to registries before pulling images
	if (operation === 'up' || operation === 'pull') {
		await loginToRegistries(dockerHost, logPrefix);
	}

	try {
		console.log(`${logPrefix} Spawning docker compose process...`);
		const proc = Bun.spawn(args, {
			cwd: stackDir,
			env: spawnEnv,
			stdin: useStdin ? 'pipe' : 'inherit',
			stdout: 'pipe',
			stderr: 'pipe'
		});

		// If using stdin (host path translation), write the modified compose content
		if (useStdin && proc.stdin) {
			proc.stdin.write(finalComposeContent);
			proc.stdin.end();
		}

		// Set up timeout with SIGTERM -> SIGKILL escalation
		let timedOut = false;
		const timeoutId = setTimeout(() => {
			timedOut = true;
			console.log(`${logPrefix} TIMEOUT: Process exceeded ${COMPOSE_TIMEOUT_MS / 1000} seconds, sending SIGTERM`);
			proc.kill('SIGTERM');
			// Give process grace period to terminate cleanly before SIGKILL
			setTimeout(() => {
				try {
					proc.kill('SIGKILL');
					console.log(`${logPrefix} TIMEOUT: Sent SIGKILL after grace period`);
				} catch {
					// Process may already be dead
				}
			}, COMPOSE_KILL_GRACE_MS);
		}, COMPOSE_TIMEOUT_MS);

		try {
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text()
			]);

			const code = await proc.exited;

			console.log(`${logPrefix} ----------------------------------------`);
			console.log(`${logPrefix} COMPOSE PROCESS COMPLETE`);
			console.log(`${logPrefix} ----------------------------------------`);
			console.log(`${logPrefix} Exit code:`, code);
			console.log(`${logPrefix} Timed out:`, timedOut);
			if (stdout) {
				console.log(`${logPrefix} STDOUT:`);
				console.log(stdout);
			}
			if (stderr) {
				console.log(`${logPrefix} STDERR:`);
				console.log(stderr);
			}

			if (timedOut) {
				return {
					success: false,
					output: stdout,
					error: `docker compose ${operation} timed out after ${COMPOSE_TIMEOUT_MS / 1000} seconds`
				};
			}

			if (code === 0) {
				return {
					success: true,
					output: stdout || stderr || `Stack "${stackName}" ${operation} completed successfully`
				};
			} else {
				return {
					success: false,
					output: stdout,
					error: stderr || `docker compose ${operation} exited with code ${code}`
				};
			}
		} finally {
			clearTimeout(timeoutId);
		}
	} catch (err: any) {
		console.log(`${logPrefix} EXCEPTION in executeLocalCompose:`, err.message);
		return {
			success: false,
			output: '',
			error: `Failed to run docker compose ${operation}: ${err.message}`
		};
	} finally {
		// Cleanup temp override file from host path translation
		if (tempOverridePath) {
			try {
				unlinkSync(tempOverridePath);
			} catch {
				// Ignore cleanup errors
			}
		}

		// Cleanup TLS temp directory (always runs, even on exception)
		if (tlsCertDir) {
			activeTlsDirs.delete(tlsCertDir);
			try {
				rmSync(tlsCertDir, { recursive: true, force: true });
				console.log(`${logPrefix} Cleaned up TLS temp directory: ${tlsCertDir}`);
			} catch {
				// Ignore cleanup errors
			}
		}
	}
}

/**
 * Execute a docker compose command via Hawser agent.
 *
 * @param envVars - Non-secret environment variables (from .env file)
 * @param secretVars - Secret environment variables (injected via shell env on Hawser, NEVER in .env)
 */
async function executeComposeViaHawser(
	operation: 'up' | 'down' | 'stop' | 'start' | 'restart' | 'pull',
	stackName: string,
	composeContent: string,
	envId: number,
	envVars?: Record<string, string>,
	secretVars?: Record<string, string>,
	forceRecreate?: boolean,
	removeVolumes?: boolean,
	stackFiles?: Record<string, string>,
	serviceName?: string,
	composeFileName?: string
): Promise<StackOperationResult> {
	const logPrefix = `[Stack:${stackName}]`;
	// Import dockerFetch dynamically to avoid circular dependency
	const { dockerFetch } = await import('./docker.js');

	// Merge envVars and secretVars for passing to Hawser
	// Hawser will inject ALL these as shell environment variables (secrets are NOT written to .env)
	const allEnvVars = { ...(envVars || {}), ...(secretVars || {}) };
	const secretCount = secretVars ? Object.keys(secretVars).length : 0;

	console.log(`${logPrefix} ----------------------------------------`);
	console.log(`${logPrefix} EXECUTE COMPOSE VIA HAWSER`);
	console.log(`${logPrefix} ----------------------------------------`);
	console.log(`${logPrefix} Operation:`, operation);
	console.log(`${logPrefix} Environment ID:`, envId);
	console.log(`${logPrefix} Force recreate:`, forceRecreate ?? false);
	console.log(`${logPrefix} Remove volumes:`, removeVolumes ?? false);
	console.log(`${logPrefix} Service name:`, serviceName ?? '(all services)');
	console.log(`${logPrefix} Compose filename:`, composeFileName ?? '(auto-detect)');
	console.log(`${logPrefix} Non-secret env vars count:`, envVars ? Object.keys(envVars).length : 0);
	console.log(`${logPrefix} Secret env vars count:`, secretCount);
	if (allEnvVars && Object.keys(allEnvVars).length > 0) {
		console.log(`${logPrefix} All env vars being sent (masked):`, JSON.stringify(maskSecrets(allEnvVars), null, 2));
	}
	console.log(`${logPrefix} Compose content length:`, composeContent.length, 'chars');
	console.log(`${logPrefix} Stack files count:`, stackFiles ? Object.keys(stackFiles).length : 0);
	if (stackFiles && Object.keys(stackFiles).length > 0) {
		console.log(`${logPrefix} Stack files:`, Object.keys(stackFiles).join(', '));
	}

	try {
		// Build files map - include .env file ONLY for non-secret envVars
		// Secrets are passed separately via allEnvVars and injected via shell env
		const files: Record<string, string> = { ...(stackFiles || {}) };
		if (envVars && Object.keys(envVars).length > 0) {
			if (files['.env']) {
				// stackFiles already has .env (e.g., from git repo with comments)
				// Don't overwrite - the envVars are already passed separately for variable substitution
				console.log(`${logPrefix} Preserving existing .env from stackFiles (${files['.env'].length} chars), envVars passed separately for substitution`);
			} else {
				// No .env in stackFiles - generate one from NON-SECRET envVars only
				const envContent = Object.entries(envVars)
					.map(([key, value]) => `${key}=${value}`)
					.join('\n');
				files['.env'] = envContent;
				console.log(`${logPrefix} Generated .env file with ${Object.keys(envVars).length} non-secret variables`);
			}
		}

		// Fetch registry credentials for Hawser to use for docker login
		const { getRegistries } = await import('./db.js');
		const allRegistries = await getRegistries();
		const registries = allRegistries
			.filter(r => r.username && r.password)
			.map(r => ({
				url: r.url,
				username: r.username!,
				password: r.password!
			}));
		if (registries.length > 0) {
			console.log(`${logPrefix} Sending ${registries.length} registry credentials to Hawser`);
		}

		const body = JSON.stringify({
			operation,
			projectName: stackName,
			composeFile: composeContent,
			composeFileName, // Explicit compose filename to use (e.g., "docker-compose.prod.yml")
			envVars: allEnvVars, // All vars (including secrets) - Hawser injects via shell env
			files, // Files including .env (secrets NOT in .env file)
			forceRecreate: forceRecreate || false,
			removeVolumes: removeVolumes || false,
			registries, // Registry credentials for docker login
			serviceName // Target specific service only (with --no-deps)
		});

		console.log(`${logPrefix} Sending request to Hawser agent...`);
		const response = await dockerFetch(
			'/_hawser/compose',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body
			},
			envId
		);

		const result = (await response.json()) as {
			success: boolean;
			output?: string;
			error?: string;
		};

		console.log(`${logPrefix} ----------------------------------------`);
		console.log(`${logPrefix} HAWSER RESPONSE`);
		console.log(`${logPrefix} ----------------------------------------`);
		console.log(`${logPrefix} Success:`, result.success);
		if (result.output) {
			console.log(`${logPrefix} Output:`, result.output);
		}
		if (result.error) {
			console.log(`${logPrefix} Error:`, result.error);
		}

		if (result.success) {
			return {
				success: true,
				output: result.output || `Stack "${stackName}" ${operation} completed via Hawser`
			};
		} else {
			return {
				success: false,
				output: result.output || '',
				error: result.error || `Compose ${operation} failed`
			};
		}
	} catch (err: any) {
		console.log(`${logPrefix} EXCEPTION in executeComposeViaHawser:`, err.message);
		return {
			success: false,
			output: '',
			error: `Failed to ${operation} via Hawser: ${err.message}`
		};
	}
}

/**
 * Route compose command to appropriate executor based on connection type.
 *
 * @param envVars - Non-secret environment variables (from .env file)
 * @param secretVars - Secret environment variables (from DB, injected via shell env)
 */
async function executeComposeCommand(
	operation: 'up' | 'down' | 'stop' | 'start' | 'restart' | 'pull',
	options: ComposeCommandOptions,
	composeContent: string,
	envVars?: Record<string, string>,
	secretVars?: Record<string, string>
): Promise<StackOperationResult> {
	const { stackName, envId, forceRecreate, removeVolumes, stackFiles, workingDir, composePath, envPath, useOverrideFile, serviceName, composeFileName } = options;

	// Get environment configuration
	const env = envId ? await getEnvironment(envId) : null;

	if (!env) {
		// Local socket connection (no environment specified)
		return executeLocalCompose(
			operation,
			stackName,
			composeContent,
			undefined,    // dockerHost
			undefined,    // tlsConfig
			envVars,
			secretVars,
			forceRecreate,
			removeVolumes,
			envId,
			workingDir,
			composePath,
			envPath,
			useOverrideFile,
			serviceName
		);
	}

	switch (env.connectionType) {
		case 'hawser-standard':
		case 'hawser-edge': {
			// For Hawser deployments, we need to read the .env file and send variables via envVars
			// because Docker Compose on the remote host may not auto-read the .env file reliably.
			// Local deployments use --env-file flag, but Hawser needs variables injected via shell env.
			let hawserEnvVars = envVars;
			if (envPath && existsSync(envPath)) {
				try {
					const envFileContent = await Bun.file(envPath).text();
					const envFileVars = parseEnvFileContent(envFileContent, stackName);
					// Merge: envFileVars (lowest) < envVars (DB overrides)
					// secretVars are handled separately in executeComposeViaHawser
					hawserEnvVars = { ...envFileVars, ...(envVars || {}) };
					console.log(`[Stack:${stackName}] Read ${Object.keys(envFileVars).length} vars from .env file for Hawser injection`);
				} catch (err) {
					console.warn(`[Stack:${stackName}] Failed to read .env file at ${envPath}:`, err);
				}
			}

			// Include compose override file if it exists alongside the compose file
			let hawserStackFiles = stackFiles;
			const composeDir = workingDir || (composePath ? dirname(composePath) : null);
			const composeBaseName = composePath ? basename(composePath) : 'compose.yaml';
			if (composeDir) {
				const overridePath = findComposeOverrideFile(composeDir, composeBaseName);
				if (overridePath) {
					try {
						const overrideContent = await Bun.file(overridePath).text();
						hawserStackFiles = { ...(hawserStackFiles || {}), [basename(overridePath)]: overrideContent };
						console.log(`[Stack:${stackName}] Including override file for Hawser: ${basename(overridePath)}`);
					} catch (err) {
						console.warn(`[Stack:${stackName}] Failed to read override file at ${overridePath}:`, err);
					}
				}
			}

			return executeComposeViaHawser(
				operation,
				stackName,
				composeContent,
				envId!,
				hawserEnvVars,
				secretVars,
				forceRecreate,
				removeVolumes,
				hawserStackFiles,
				serviceName,
				composeFileName
			);
		}

		case 'direct': {
			const port = env.port || 2375;
			const dockerHost = `tcp://${env.host}:${port}`;

			// Build TLS config if using HTTPS
			const tlsConfig: TlsConfig | undefined = env.protocol === 'https' ? {
				ca: env.tlsCa || undefined,
				cert: env.tlsCert || undefined,
				key: env.tlsKey || undefined,
				skipVerify: env.tlsSkipVerify ?? false
			} : undefined;

			return executeLocalCompose(
				operation,
				stackName,
				composeContent,
				dockerHost,
				tlsConfig,
				envVars,
				secretVars,
				forceRecreate,
				removeVolumes,
				envId,
				workingDir,
				composePath,
				envPath,
				useOverrideFile,
				serviceName
			);
		}

		case 'socket':
		default:
			return executeLocalCompose(
				operation,
				stackName,
				composeContent,
				undefined,    // dockerHost
				undefined,    // tlsConfig
				envVars,
				secretVars,
				forceRecreate,
				removeVolumes,
				envId,
				workingDir,
				composePath,
				envPath,
				useOverrideFile,
				serviceName
			);
	}
}

// =============================================================================
// STACK DISCOVERY
// =============================================================================

/**
 * List all compose stacks from Docker containers
 */
export async function listComposeStacks(envId?: number | null): Promise<ComposeStackInfo[]> {
	// Import dynamically to avoid circular dependency
	const { listContainers } = await import('./docker.js');

	const containers = await listContainers(true, envId);
	const stacks = new Map<string, Set<string>>();

	containers.forEach((container) => {
		const projectLabel = container.labels['com.docker.compose.project'];
		if (projectLabel) {
			if (!stacks.has(projectLabel)) {
				stacks.set(projectLabel, new Set());
			}
			stacks.get(projectLabel)?.add(container.id);
		}
	});

	const result: ComposeStackInfo[] = Array.from(stacks.entries()).map(([name, containerIds]) => {
		const stackContainers = containers.filter((c) => containerIds.has(c.id));
		const runningCount = stackContainers.filter((c) => c.state === 'running').length;

		const containerDetails: ContainerDetail[] = stackContainers
			.map((c) => {
				const service = c.labels['com.docker.compose.service'] || c.name;

				// Build ports with structured data for clickable links
				const ports = (c.ports || [])
					.filter((p) => p.PublicPort)
					.map((p) => ({
						publicPort: p.PublicPort!,
						privatePort: p.PrivatePort,
						type: p.Type,
						display: `${p.PublicPort}:${p.PrivatePort}/${p.Type}`
					}));

				// Build networks with IP addresses
				const networks = Object.entries(c.networks || {}).map(([name, data]) => ({
					name,
					ipAddress: data?.ipAddress || ''
				}));

				const volumeCount = c.mounts?.length || 0;

				return {
					id: c.id,
					name: c.name,
					service,
					state: c.state,
					status: c.status,
					health: c.health,
					image: c.image,
					ports,
					networks,
					volumeCount,
					restartCount: c.restartCount || 0,
					created: c.created
				};
			})
			.sort((a, b) => a.service.localeCompare(b.service));

		return {
			name,
			containers: Array.from(containerIds),
			containerDetails,
			status:
				runningCount === stackContainers.length
					? 'running'
					: runningCount === 0
						? 'stopped'
						: 'partial'
		};
	});

	return result;
}

/**
 * Get containers for a specific stack by label
 */
async function getStackContainers(stackName: string, envId?: number | null): Promise<any[]> {
	const { listContainers } = await import('./docker.js');
	const containers = await listContainers(true, envId);
	return containers.filter((c) => c.labels['com.docker.compose.project'] === stackName);
}

/**
 * Extract path hints from Docker container labels for a stack.
 * Docker Compose adds labels like:
 * - com.docker.compose.project.working_dir: /path/to/stack
 * - com.docker.compose.project.config_files: /path/to/docker-compose.yml[,...]
 */
export async function getStackPathHints(
	stackName: string,
	envId?: number | null
): Promise<{
	workingDir: string | null;
	configFiles: string[] | null;
}> {
	const containers = await getStackContainers(stackName, envId);

	if (containers.length === 0) {
		return { workingDir: null, configFiles: null };
	}

	// Get labels from first container (all containers in stack have same project labels)
	const labels = containers[0].labels || {};

	const workingDir = labels['com.docker.compose.project.working_dir'] || null;
	const configFilesRaw = labels['com.docker.compose.project.config_files'] || null;

	// Config files can be comma-separated if multiple compose files were used
	const configFiles = configFilesRaw ? configFilesRaw.split(',').map((f: string) => f.trim()) : null;

	return { workingDir, configFiles };
}

/**
 * Stop or remove orphan containers that belong to a stack but aren't defined in the compose file.
 * These are dynamically-spawned child containers (e.g., nextcloud-aio master creates worker containers).
 * Best-effort: errors are logged but don't fail the overall operation.
 */
async function cleanupOrphanStackContainers(
	stackName: string,
	envId: number | null | undefined,
	operation: 'stop' | 'remove' | 'restart'
): Promise<void> {
	try {
		const containers = await getStackContainers(stackName, envId);
		const targets = containers.filter(
			(c) => c.state === 'running' || c.state === 'restarting'
		);
		if (targets.length === 0) return;

		const { stopContainer, removeContainer, restartContainer } = await import('./docker.js');
		const results = await Promise.allSettled(
			targets.map((c) => {
				if (operation === 'remove') return removeContainer(c.id, true, envId);
				if (operation === 'restart') return restartContainer(c.id, envId);
				return stopContainer(c.id, envId);
			})
		);

		const failures = results.filter((r) => r.status === 'rejected');
		if (failures.length > 0) {
			console.warn(
				`[stacks] ${failures.length} orphan container(s) failed to ${operation} for stack "${stackName}"`
			);
		}
	} catch (err) {
		console.warn(`[stacks] Failed to cleanup orphan containers for stack "${stackName}":`, err);
	}
}

/**
 * Helper to perform container-based operations for external stacks
 * Used as fallback when no compose file exists.
 * Uses Promise.allSettled for parallel execution.
 */
async function withContainerFallback(
	stackName: string,
	envId: number | null | undefined,
	operation: 'start' | 'stop' | 'restart' | 'remove'
): Promise<StackOperationResult> {
	const { startContainer, stopContainer, restartContainer, removeContainer } = await import('./docker.js');

	const containers = await getStackContainers(stackName, envId);
	if (containers.length === 0) {
		return { success: false, error: `No containers found for stack "${stackName}"` };
	}

	// Execute all container operations in parallel
	// Note: listContainers returns containers with lowercase property names: id, name, labels
	const operationResults = await Promise.allSettled(
		containers.map(async (container) => {
			const containerName = container.name || container.id;
			switch (operation) {
				case 'start':
					await startContainer(container.id, envId);
					break;
				case 'stop':
					await stopContainer(container.id, envId);
					break;
				case 'restart':
					await restartContainer(container.id, envId);
					break;
				case 'remove':
					await removeContainer(container.id, true, envId);
					break;
			}
			return containerName;
		})
	);

	// Collect successes and failures
	const successes: string[] = [];
	const errors: string[] = [];

	operationResults.forEach((result, index) => {
		const containerName = containers[index].name || containers[index].id;
		if (result.status === 'fulfilled') {
			successes.push(result.value);
		} else {
			errors.push(`${containerName}: ${result.reason?.message || 'Unknown error'}`);
		}
	});

	if (errors.length > 0) {
		return {
			success: successes.length > 0,
			error: errors.join('; '),
			output: successes.length > 0 ? `Partial success: ${successes.join(', ')}` : undefined
		};
	}

	return {
		success: true,
		output: `${operation} completed for ${successes.length} container(s): ${successes.join(', ')}`
	};
}

// =============================================================================
// STACK LIFECYCLE OPERATIONS
// =============================================================================

/**
 * Result type for requireComposeFile - can indicate stack needs file location
 */
export interface RequireComposeResult {
	success: boolean;
	content?: string;
	secretVars?: Record<string, string>;
	/** Non-secret variables from database (needed for compose interpolation) */
	nonSecretVars?: Record<string, string>;
	needsFileLocation?: boolean;
	error?: string;
	/** Directory containing the compose file (for working directory) */
	stackDir?: string;
	/** Full path to the compose file (for imported stacks) */
	composePath?: string;
	/** Full path to the env file (for --env-file flag) */
	envPath?: string;
}

/**
 * Get compose file and secret vars for stack operations.
 *
 * Returns:
 * - content: The compose file content
 * - secretVars: Secret variables (from DB only, for shell injection)
 * - envPath: Path to the .env file (Docker Compose reads non-secrets from it)
 * - needsFileLocation: true if stack needs user to specify file paths
 */
async function requireComposeFile(
	stackName: string,
	envId?: number | null,
	composeConfigPath?: string
): Promise<RequireComposeResult> {
	const composeResult = await getStackComposeFile(stackName, envId, composeConfigPath);

	// If compose file not found, return info about what's needed
	if (!composeResult.success) {
		if (composeResult.needsFileLocation) {
			return {
				success: false,
				needsFileLocation: true,
				error: composeResult.error
			};
		}
		return {
			success: false,
			error: composeResult.error || `Compose file not found for stack "${stackName}"`
		};
	}

	// Get SECRET variables from database (for shell injection at runtime)
	// These are NEVER written to disk
	const secretVars = await getSecretEnvVarsAsRecord(stackName, envId);

	// Get NON-SECRET variables from database (needed for compose interpolation)
	// For git stacks without .env files, these are the only source of env vars
	const nonSecretVars = await getNonSecretEnvVarsAsRecord(stackName, envId);

	// Determine env file path for --env-file flag
	// For stacks with custom composePath (adopted/external), derive envPath from same directory
	// For internal stacks, use the default data directory
	let envFilePath: string | null = null;

	if (composeResult.composePath) {
		// Adopted/external stack with custom compose path
		if (composeResult.envPath) {
			// Explicit env path stored in database
			envFilePath = composeResult.envPath;
		} else if (composeResult.envPath === '') {
			// Explicitly no env file (user selected "no .env")
			envFilePath = null;
		} else {
			// envPath is null - look for .env next to the compose file
			envFilePath = join(dirname(composeResult.composePath), '.env');
		}
	} else {
		// Internal stack - use default data directory location
		const stackDir = composeResult.stackDir || await findStackDir(stackName, envId) || await getStackDir(stackName, envId);
		envFilePath = join(stackDir, '.env');
	}

	// Docker Compose reads non-secrets from the .env file via --env-file.
	// Secrets and non-secrets from DB need to be injected via shell environment
	// for stacks without .env files (e.g., git stacks with manual env vars).
	return {
		success: true,
		content: composeResult.content!,
		secretVars,
		nonSecretVars,
		stackDir: composeResult.stackDir,
		composePath: composeResult.composePath ?? undefined,
		envPath: envFilePath ?? undefined
	};
}

/**
 * Start a stack using docker compose up
 * Falls back to individual container start for stacks without compose files
 */
export async function startStack(
	stackName: string,
	envId?: number | null
): Promise<StackOperationResult> {
	const result = await requireComposeFile(stackName, envId);

	if (!result.success) {
		// No compose file - fall back to container-based operations
		return withContainerFallback(stackName, envId, 'start');
	}

	return executeComposeCommand(
		'up',
		{ stackName, envId, workingDir: result.stackDir, composePath: result.composePath, envPath: result.envPath },
		result.content!,
		result.nonSecretVars,
		result.secretVars
	);
}

/**
 * Stop a stack using docker compose stop
 * Falls back to individual container stop for stacks without compose files
 */
export async function stopStack(
	stackName: string,
	envId?: number | null
): Promise<StackOperationResult> {
	const result = await requireComposeFile(stackName, envId);

	if (!result.success) {
		// No compose file - fall back to container-based operations
		return withContainerFallback(stackName, envId, 'stop');
	}

	const composeResult = await executeComposeCommand(
		'stop',
		{ stackName, envId, workingDir: result.stackDir, composePath: result.composePath, envPath: result.envPath },
		result.content!,
		result.nonSecretVars,
		result.secretVars
	);

	// Stop any dynamically-spawned child containers not in the compose file
	await cleanupOrphanStackContainers(stackName, envId, 'stop');

	return composeResult;
}

/**
 * Restart a stack using docker compose restart
 * Falls back to individual container restart for stacks without compose files
 */
export async function restartStack(
	stackName: string,
	envId?: number | null
): Promise<StackOperationResult> {
	const result = await requireComposeFile(stackName, envId);

	if (!result.success) {
		// No compose file - fall back to container-based operations
		return withContainerFallback(stackName, envId, 'restart');
	}

	const composeResult = await executeComposeCommand(
		'restart',
		{ stackName, envId, workingDir: result.stackDir, composePath: result.composePath, envPath: result.envPath },
		result.content!,
		result.nonSecretVars,
		result.secretVars
	);

	// Restart any dynamically-spawned child containers not in the compose file
	await cleanupOrphanStackContainers(stackName, envId, 'restart');

	return composeResult;
}

/**
 * Down a stack using docker compose down (removes containers, keeps files)
 * For stacks without compose files, this is equivalent to stop
 */
export async function downStack(
	stackName: string,
	envId?: number | null,
	removeVolumes = false
): Promise<StackOperationResult> {
	const result = await requireComposeFile(stackName, envId);

	if (!result.success) {
		// No compose file - down is the same as stop
		return withContainerFallback(stackName, envId, 'stop');
	}

	const composeResult = await executeComposeCommand(
		'down',
		{ stackName, envId, removeVolumes, workingDir: result.stackDir, composePath: result.composePath, envPath: result.envPath },
		result.content!,
		result.nonSecretVars,
		result.secretVars
	);

	// Remove any dynamically-spawned child containers not in the compose file
	await cleanupOrphanStackContainers(stackName, envId, 'remove');

	return composeResult;
}

/**
 * Remove a stack completely (compose down + delete files + cleanup database)
 * Uses stack locking to prevent concurrent operations.
 */
export async function removeStack(
	stackName: string,
	envId?: number | null,
	force = false
): Promise<StackOperationResult> {
	return withStackLock(stackName, async () => {
		// Get compose file (may not exist for external stacks)
		const composeResult = await getStackComposeFile(stackName, envId);

		// Get stack containers BEFORE removing them (for cleanup later)
		const stackContainers = await getStackContainers(stackName, envId);

		// If compose file exists, run docker compose down first
		if (composeResult.success) {
			const envVars = await getNonSecretEnvVarsAsRecord(stackName, envId);
			const secretVars = await getSecretEnvVarsAsRecord(stackName, envId);
			const downResult = await executeComposeCommand(
				'down',
				{
					stackName,
					envId,
					workingDir: composeResult.stackDir,
					composePath: composeResult.composePath ?? undefined,
					envPath: composeResult.envPath ?? undefined
				},
				composeResult.content!,
				envVars,
				secretVars
			);
			if (!downResult.success && !force) {
				return downResult;
			}

			// Remove any dynamically-spawned child containers not handled by compose
			await cleanupOrphanStackContainers(stackName, envId, 'remove');
		} else {
			// External stack - remove containers directly in parallel
			const { removeContainer } = await import('./docker.js');

			const removalResults = await Promise.allSettled(
				stackContainers.map((container) =>
					removeContainer(container.id, force, envId).then(() => container.name)
				)
			);

			const errors: string[] = [];
			removalResults.forEach((result, index) => {
				if (result.status === 'rejected') {
					const containerName = stackContainers[index].name || stackContainers[index].id;
					errors.push(`Failed to remove ${containerName}: ${result.reason?.message || 'Unknown error'}`);
				}
			});

			if (errors.length > 0 && !force) {
				return {
					success: false,
					error: errors.join('; ')
				};
			}
		}

		// Clean up auto-update schedules and pending updates for stack containers
		const envIdNum = typeof envId === 'number' ? envId : undefined;
		for (const container of stackContainers) {
			const containerName = container.names?.[0]?.replace(/^\//, '') || container.name;
			const containerId = container.id;

			// Clean up auto-update schedule
			try {
				const setting = await getAutoUpdateSetting(containerName, envIdNum);
				if (setting) {
					unregisterSchedule(setting.id, 'container_update');
					await deleteAutoUpdateSchedule(containerName, envIdNum);
				}
			} catch {
				// Ignore cleanup errors
			}

			// Clean up pending container update
			try {
				if (envIdNum) {
					await removePendingContainerUpdate(envIdNum, containerId);
				}
			} catch {
				// Ignore cleanup errors
			}
		}

		// Clean up database records - collect errors but don't stop
		const cleanupErrors: string[] = [];

		// Delete compose file and directory
		// Only delete files that are within Dockhand's data directory (stacks we created)
		// Adopted/imported stacks have files outside DATA_DIR and should be preserved
		const stackSource = await getStackSource(stackName, envId);
		const stacksDir = getStacksDir();

		// Determine what directory to delete (if any)
		let stackDir: string | null = null;

		if (stackSource?.composePath) {
			// Check if the compose path is within Dockhand's stacks directory
			const customDir = dirname(stackSource.composePath);
			const resolvedCustomDir = resolve(customDir);
			const resolvedStacksDir = resolve(stacksDir);

			// Only delete if the directory is within DATA_DIR/stacks/ (files we created)
			// AND the directory basename matches the stack name exactly (for safety)
			if (resolvedCustomDir.startsWith(resolvedStacksDir) &&
				basename(resolvedCustomDir) === stackName &&
				existsSync(customDir)) {
				stackDir = customDir;
			}
		}

		// Fall back to default paths ONLY if no custom path was set in DB
		// (Don't delete default-path files when an adopted stack has custom path outside DATA_DIR)
		if (!stackDir && !stackSource?.composePath) {
			const defaultDir = await findStackDir(stackName, envId) || await getStackDir(stackName, envId);
			if (existsSync(defaultDir)) {
				stackDir = defaultDir;
			}
		}

		// Delete the directory if found
		if (stackDir) {
			try {
				rmSync(stackDir, { recursive: true, force: true });
			} catch (err: any) {
				console.error(`Failed to delete stack directory: ${err.message}`);
				cleanupErrors.push(`directory: ${err.message}`);
			}
			// Verify deletion succeeded (rmSync with force:true may not throw on some failures)
			if (existsSync(stackDir)) {
				const verifyErr = 'Directory still exists after deletion attempt';
				console.error(`Failed to delete stack directory: ${verifyErr}`);
				cleanupErrors.push(`directory: ${verifyErr}`);
			}
		}

		try {
			await deleteStackSource(stackName, envId);
		} catch (err: any) {
			cleanupErrors.push(`stack source: ${err.message}`);
		}

		try {
			await deleteStackEnvVars(stackName, envId);
		} catch (err: any) {
			cleanupErrors.push(`env vars: ${err.message}`);
		}

		// If git stack, clean up git stack record
		try {
			const gitStack = await getGitStackByName(stackName, envId);
			if (gitStack) {
				await deleteGitStack(gitStack.id);
				await deleteGitStackFiles(gitStack.id, gitStack.stackName, gitStack.environmentId);
			}
			// Also cleanup any orphaned git stacks with NULL environment_id for this stack name
			if (envId !== undefined && envId !== null) {
				const orphanedGitStack = await getGitStackByName(stackName, null);
				if (orphanedGitStack) {
					await deleteGitStack(orphanedGitStack.id);
					await deleteGitStackFiles(orphanedGitStack.id, orphanedGitStack.stackName, orphanedGitStack.environmentId);
				}
			}
		} catch (err: any) {
			cleanupErrors.push(`git stack: ${err.message}`);
		}

		// Check if directory deletion failed - this blocks stack recreation
		const directoryError = cleanupErrors.find(e => e.startsWith('directory:'));
		if (directoryError) {
			return {
				success: false,
				error: `Stack containers stopped but directory cleanup failed (${directoryError}). Cannot recreate stack with same name until directory is manually removed.`
			};
		}

		// Return success with optional cleanup warnings for non-critical errors
		const output = cleanupErrors.length > 0
			? `Stack "${stackName}" removed with cleanup warnings: ${cleanupErrors.join('; ')}`
			: `Stack "${stackName}" removed successfully`;

		return { success: true, output };
	});
}

/**
 * Deploy a stack (create or update)
 * Uses stack locking to prevent concurrent deployments.
 */
export async function deployStack(options: DeployStackOptions): Promise<StackOperationResult> {
	const { name, compose, envId, sourceDir, forceRecreate, composePath, envPath, composeFileName, envFileName } = options;
	const logPrefix = `[Stack:${name}]`;

	console.log(`${logPrefix} ========================================`);
	console.log(`${logPrefix} DEPLOY STACK START`);
	console.log(`${logPrefix} ========================================`);
	console.log(`${logPrefix} Environment ID:`, envId ?? '(none - local)');
	console.log(`${logPrefix} Force recreate:`, forceRecreate ?? false);
	console.log(`${logPrefix} Source directory:`, sourceDir ?? '(none)');
	console.log(`${logPrefix} Custom compose path:`, composePath ?? '(none)');
	console.log(`${logPrefix} Custom env path:`, envPath ?? '(none)');
	console.log(`${logPrefix} Compose filename:`, composeFileName ?? '(none)');
	console.log(`${logPrefix} Env filename:`, envFileName ?? '(none)');

	// Validate stack name - Docker Compose requires lowercase alphanumeric, hyphens, underscores
	// Must also start with a letter or number
	if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
		console.log(`${logPrefix} ERROR: Invalid stack name format`);
		return {
			success: false,
			output: '',
			error: 'Stack name must be lowercase, start with a letter or number, and contain only letters, numbers, hyphens, and underscores'
		};
	}

	return withStackLock(name, async () => {
		// Determine working directory: use custom composePath directory if provided,
		// otherwise fall back to internal stack directory
		let workingDir: string;
		let actualComposePath: string | undefined;
		let actualEnvPath: string | undefined = envPath; // Start with provided envPath (for adopted stacks)
		let stackFiles: Record<string, string> | undefined;

		if (composePath) {
			// Adopted/imported stack: use the original compose file location
			// This ensures relative paths in the compose file resolve correctly
			// Files are NOT copied - we use them in-place at their original location
			workingDir = dirname(composePath);
			actualComposePath = composePath;
			console.log(`${logPrefix} Using custom compose path, workingDir:`, workingDir);
		} else if (sourceDir && existsSync(sourceDir)) {
			// Git stack: copy entire source directory to internal stack directory
			workingDir = await getStackDir(name, envId);

			// Set actualComposePath using the provided compose filename from git stack config
			if (composeFileName) {
				actualComposePath = join(workingDir, composeFileName);
				console.log(`${logPrefix} Using compose filename from git config:`, composeFileName);
			} else {
				// Detect compose file in source directory
				const composeNames = ['docker-compose.yaml', 'docker-compose.yml', 'compose.yaml', 'compose.yml'];
				for (const cn of composeNames) {
					if (existsSync(join(sourceDir, cn))) {
						actualComposePath = join(workingDir, cn);
						console.log(`${logPrefix} Detected compose file:`, cn);
						break;
					}
				}
			}

			// Set actualEnvPath using the provided env filename from git stack config
			// Only if envFileName is provided (env file is optional for git stacks)
			if (envFileName) {
				actualEnvPath = join(workingDir, envFileName);
				console.log(`${logPrefix} Using env filename from git config:`, envFileName);
				console.log(`${logPrefix} Actual env path will be:`, actualEnvPath);
			}

			// Read all files for Hawser deployments
			stackFiles = await readDirFilesAsMap(sourceDir);
			console.log(`${logPrefix} Read ${Object.keys(stackFiles).length} files from source directory`);
			console.log(`${logPrefix} Files:`, Object.keys(stackFiles).join(', '));

			// Copy source to stack directory
			console.log(`${logPrefix} Copying source directory to stack directory...`);
			if (existsSync(workingDir)) {
				rmSync(workingDir, { recursive: true, force: true });
			}
			cpSync(sourceDir, workingDir, { recursive: true });
			console.log(`${logPrefix} Copied ${sourceDir} -> ${workingDir}`);
		} else {
			// Internal stack: check if a custom path exists in DB (adopted/imported stacks)
			const source = await getStackSource(name, envId);
			if (source?.composePath) {
				workingDir = dirname(source.composePath);
				actualComposePath = source.composePath;
				if (source.envPath) {
					actualEnvPath = source.envPath;
				}
				console.log(`${logPrefix} Using custom path from DB:`, workingDir);
			} else {
				// Default: compose file should already exist (written by saveStackComposeFile)
				workingDir = await getStackDir(name, envId);
				console.log(`${logPrefix} Using internal stack directory:`, workingDir);
			}

		}

		// For Hawser deployments: include compose and .env in stackFiles
		// Hawser writes files from the files map to disk at STACKS_DIR/{stackName}/
		if (!stackFiles) {
			stackFiles = {};
		}
		const composeFilename = actualComposePath ? basename(actualComposePath) : 'compose.yaml';
		if (!stackFiles[composeFilename]) {
			stackFiles[composeFilename] = compose;
			console.log(`${logPrefix} Added ${composeFilename} to stackFiles for Hawser (${compose.length} chars)`);
		}
		if (actualEnvPath && existsSync(actualEnvPath) && !stackFiles['.env']) {
			try {
				const envContent = await Bun.file(actualEnvPath).text();
				stackFiles['.env'] = envContent;
				console.log(`${logPrefix} Added .env to stackFiles for Hawser (${envContent.length} chars)`);
			} catch (err) {
				console.warn(`${logPrefix} Failed to read .env file at ${actualEnvPath}:`, err);
			}
		}

		console.log(`${logPrefix} Compose content length:`, compose.length, 'chars');
		console.log(`${logPrefix} Compose content (full):`);
		console.log(compose);

		// Fetch overrides and secrets from DB
		const dbNonSecretVars = await getNonSecretEnvVarsAsRecord(name, envId);
		const secretVars = await getSecretEnvVarsAsRecord(name, envId);
		console.log(`${logPrefix} DB non-secret override vars:`, Object.keys(dbNonSecretVars).length);
		console.log(`${logPrefix} DB secret vars:`, Object.keys(secretVars).length);

		// For git stacks (sourceDir provided), use the override file (.env.dockhand)
		// to layer editor overrides on top of the repo's .env file.
		// Only DB overrides go into .env.dockhand - repo values are already in the repo's env file.
		// For internal/adopted stacks, the .env file is already the editor's output,
		// so no override file is needed - only pass secrets for shell injection.
		const isGitStack = !!sourceDir;

		console.log(`${logPrefix} Calling executeComposeCommand...`);
		const result = await executeComposeCommand(
			'up',
			{
				stackName: name,
				envId,
				forceRecreate,
				stackFiles,
				workingDir,
				composePath: actualComposePath,
				envPath: actualEnvPath,
				useOverrideFile: isGitStack,
				// Pass compose filename for Hawser (extracted from path or provided explicitly)
				composeFileName: composeFileName || (actualComposePath ? basename(actualComposePath) : undefined)
			},
			compose,
			isGitStack ? dbNonSecretVars : undefined,
			secretVars
		);
		console.log(`${logPrefix} ========================================`);
		console.log(`${logPrefix} DEPLOY STACK RESULT`);
		console.log(`${logPrefix} ========================================`);
		console.log(`${logPrefix} Success:`, result.success);
		if (result.output) {
			console.log(`${logPrefix} Output:`, result.output);
		}
		if (result.error) {
			console.log(`${logPrefix} Error:`, result.error);
		}
		return result;
	});
}

/**
 * Pull images for a stack
 */
export async function pullStackImages(
	stackName: string,
	envId?: number | null
): Promise<{ success: boolean; output?: string; error?: string }> {
	const result = await requireComposeFile(stackName, envId);

	if (!result.success) {
		return {
			success: false,
			error: result.error || 'Compose file not found'
		};
	}

	return executeComposeCommand(
		'pull',
		{ stackName, envId, workingDir: result.stackDir, composePath: result.composePath, envPath: result.envPath },
		result.content!,
		result.nonSecretVars,
		result.secretVars
	);
}

/**
 * Pull image for a specific service within a stack using docker compose pull <service>.
 * This is the Compose-native approach to pulling images for auto-updates.
 *
 * @param stackName - The compose project name
 * @param serviceName - The service name to pull
 * @param envId - Optional environment ID
 * @returns Operation result
 */
export async function pullStackService(
	stackName: string,
	serviceName: string,
	envId?: number | null,
	composeConfigPath?: string
): Promise<StackOperationResult> {
	const result = await requireComposeFile(stackName, envId, composeConfigPath);

	if (!result.success) {
		return {
			success: false,
			error: result.error || `Compose file not found for stack "${stackName}"`
		};
	}

	return executeComposeCommand(
		'pull',
		{
			stackName,
			envId,
			workingDir: result.stackDir,
			composePath: result.composePath,
			envPath: result.envPath,
			serviceName
		},
		result.content!,
		result.nonSecretVars,
		result.secretVars
	);
}

/**
 * Update a specific service within a stack using docker compose up -d --no-deps.
 * Docker Compose detects image changes naturally (the image is pulled beforehand),
 * so --force-recreate is not needed and can cause permission issues on bind mounts.
 * This preserves all compose configuration (static IPs, network aliases, etc.) while only
 * recreating the specified service when its image has changed.
 *
 * @param stackName - The compose project name
 * @param serviceName - The service name to update
 * @param envId - Optional environment ID
 * @returns Operation result
 */
export async function updateStackService(
	stackName: string,
	serviceName: string,
	envId?: number | null,
	composeConfigPath?: string
): Promise<StackOperationResult> {
	const result = await requireComposeFile(stackName, envId, composeConfigPath);

	if (!result.success) {
		return {
			success: false,
			error: result.error || `Compose file not found for stack "${stackName}"`
		};
	}

	// Don't use forceRecreate - Docker Compose will detect the image change
	// naturally since the image was already pulled before this function is called.
	// Using forceRecreate can cause permission issues on bind mounts.
	// This matches the behavior of: docker compose pull && docker compose up -d
	return executeComposeCommand(
		'up',
		{
			stackName,
			envId,
			workingDir: result.stackDir,
			composePath: result.composePath,
			envPath: result.envPath,
			serviceName
		},
		result.content!,
		result.nonSecretVars,
		result.secretVars
	);
}

// =============================================================================
// ENVIRONMENT VARIABLE HELPERS
// =============================================================================

/**
 * Save environment variables for a stack to the database (for secret tracking)
 */
export async function saveStackEnvVarsToDb(
	stackName: string,
	variables: { key: string; value: string; isSecret?: boolean }[],
	envId?: number | null
): Promise<void> {
	await setStackEnvVars(stackName, envId ?? null, variables);
}

/**
 * Write environment variables to the .env file on disk (simple key=value format)
 *
 * WARNING: This generates a simple key=value file WITHOUT comments or formatting.
 * ONLY use during initial stack CREATION when no .env file exists.
 *
 * For EDITS, use PUT /api/stacks/[name]/env/raw which preserves the raw content
 * including all comments, formatting, and structure.
 */
export async function writeStackEnvFile(
	stackName: string,
	variables: { key: string; value: string; isSecret?: boolean }[],
	envId?: number | null,
	customEnvPath?: string
): Promise<void> {
	let envFilePath: string;
	if (customEnvPath) {
		envFilePath = customEnvPath;
	} else {
		// Check if stack has a custom path in DB
		const source = await getStackSource(stackName, envId);
		if (source?.envPath) {
			envFilePath = source.envPath;
		} else if (source?.composePath) {
			// Derive env path from custom compose path location
			envFilePath = join(dirname(source.composePath), '.env');
		} else {
			// Fall back to default location
			envFilePath = join(await findStackDir(stackName, envId) || await getStackDir(stackName, envId), '.env');
		}
	}

	// Ensure parent directory exists
	const dir = dirname(envFilePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	// SECURITY: Only write non-secret variables to .env file
	// Secrets are stored in DB and injected via shell environment at runtime
	const rawContent = variables
		.filter(v => v.key?.trim() && !v.isSecret)
		.map(v => `${v.key.trim()}=${v.value}`)
		.join('\n') + '\n';

	await Bun.write(envFilePath, rawContent);
}

/**
 * Write raw environment content directly to the .env file (preserves comments/formatting)
 *
 * NOTE: Raw content should NOT contain secrets. Secrets are managed via the form view,
 * stored in DB, and injected via shell environment at runtime.
 */
export async function writeRawStackEnvFile(
	stackName: string,
	rawContent: string,
	envId?: number | null,
	customEnvPath?: string
): Promise<void> {
	let envFilePath: string;
	if (customEnvPath) {
		envFilePath = customEnvPath;
	} else {
		// Check if stack has a custom path in DB
		const source = await getStackSource(stackName, envId);
		if (source?.envPath) {
			envFilePath = source.envPath;
		} else if (source?.composePath) {
			// Derive env path from custom compose path location
			envFilePath = join(dirname(source.composePath), '.env');
		} else {
			// Fall back to default location
			envFilePath = join(await findStackDir(stackName, envId) || await getStackDir(stackName, envId), '.env');
		}
	}

	// Ensure parent directory exists
	const dir = dirname(envFilePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	await Bun.write(envFilePath, rawContent);
}

/**
 * Save environment variables for a stack (both to database and .env file)
 *
 * WARNING: Only use during initial stack CREATION - this generates a simple
 * key=value file that does NOT preserve comments or formatting.
 *
 * For EDITS, the StackModal saves to:
 * - PUT /api/stacks/[name]/env/raw (preserves raw content with comments)
 * - PUT /api/stacks/[name]/env (updates secret flags in DB only)
 */
export async function saveStackEnvVars(
	stackName: string,
	variables: { key: string; value: string; isSecret?: boolean }[],
	envId?: number | null,
	customEnvPath?: string
): Promise<void> {
	// Save to database for secret tracking
	await saveStackEnvVarsToDb(stackName, variables, envId);
	// Write .env file to disk for Docker Compose
	await writeStackEnvFile(stackName, variables, envId, customEnvPath);
}

// =============================================================================
// RE-EXPORTS FOR BACKWARDS COMPATIBILITY
// =============================================================================

// These exports maintain API compatibility with code that imports from docker.ts
// They can be removed once all imports are updated

export type { StackOperationResult as CreateStackResult };

