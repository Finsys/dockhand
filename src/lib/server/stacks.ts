/**
 * Stack Management Module
 *
 * Provides compose-first stack operations for internal, git, and external stacks.
 * All lifecycle operations use docker compose commands.
 */

import { existsSync, mkdirSync, rmSync, readdirSync, cpSync, statSync, unlinkSync, renameSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import {
	getEnvironment,
	getStackEnvVarsAsRecord,
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
	deleteStackEnvVars
} from './db';
import { deleteGitStackFiles } from './git';
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
	envFileVars?: Record<string, string>;
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
 * 1. New path (envName): $DATA_DIR/stacks/<envName>/<stackName>/
 * 2. ID-based path (envId): $DATA_DIR/stacks/<envId>/<stackName>/
 * 3. Legacy path: $DATA_DIR/stacks/<stackName>/
 *
 * Automatically looks up environment name from database.
 * Always checks legacy path for backwards compatibility with pre-env stacks.
 */
export async function findStackDir(stackName: string, envId?: number | null): Promise<string | null> {
	const stacksDir = getStacksDir();

	// Look up environment name if we have an ID
	if (envId) {
		const env = await getEnvironment(envId);

		// 1. Check new path (with envName)
		if (env) {
			const namePath = join(stacksDir, env.name, stackName);
			if (existsSync(namePath)) {
				return namePath;
			}
		}

		// 2. Check ID-based path
		const idPath = join(stacksDir, String(envId), stackName);
		if (existsSync(idPath)) {
			return idPath;
		}
	}

	// 3. Always check legacy path (stacks created before env-scoping was added)
	const legacyPath = join(stacksDir, stackName);
	if (existsSync(legacyPath)) {
		return legacyPath;
	}

	return null;
}

/**
 * List stacks that have compose files stored locally
 */
export function listManagedStacks(): string[] {
	const stacksDir = getStacksDir();
	if (!existsSync(stacksDir)) {
		return [];
	}

	return readdirSync(stacksDir, { withFileTypes: true })
		.filter((dirent) => dirent.isDirectory())
		.filter((dirent) => {
			// Check all valid compose filenames
			const composeNames = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];
			return composeNames.some(name => existsSync(join(stacksDir, dirent.name, name)));
		})
		.map((dirent) => dirent.name);
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
	envId?: number | null
): Promise<GetComposeFileResult> {
	const source = await getStackSource(stackName, envId);

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
	customEnvPath?: string
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

	// Build spawn environment:
	// 1. Start with process.env
	// 2. Add DOCKER_HOST if specified
	// 3. Add non-secret envVars (for backward compat when .env file doesn't exist)
	// 4. Add secret envVars (CRITICAL: these are NEVER written to disk, only passed via shell env)
	const spawnEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
	if (dockerHost) {
		spawnEnv.DOCKER_HOST = dockerHost;
	}
	// Non-secret vars (backup for when .env file doesn't exist yet)
	if (envVars) {
		Object.assign(spawnEnv, envVars);
	}
	// SECRET vars: injected via shell environment at runtime (NEVER written to .env file)
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
	const args = ['docker', 'compose', '-p', stackName, '-f', useStdin ? '-' : composeFile];

	// Add --env-file flag if env file exists
	// This makes Docker Compose load the .env file automatically (like Portainer)
	// Uses custom path if provided, otherwise defaults to .env in stack directory
	const envFilePath = customEnvPath || join(stackDir, '.env');
	if (existsSync(envFilePath)) {
		args.push('--env-file', envFilePath);
	}

	if (useStdin) {
		console.log(`${logPrefix} [HostPath] Using stdin for compose content (paths translated)`);
	}

	switch (operation) {
		case 'up':
			args.push('up', '-d', '--remove-orphans');
			if (forceRecreate) args.push('--force-recreate');
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
	stackFiles?: Record<string, string>
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
			envVars: allEnvVars, // All vars (including secrets) - Hawser injects via shell env
			files, // Files including .env (secrets NOT in .env file)
			forceRecreate: forceRecreate || false,
			removeVolumes: removeVolumes || false,
			registries // Registry credentials for docker login
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
	const { stackName, envId, forceRecreate, removeVolumes, stackFiles, workingDir, composePath, envPath } = options;

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
			envPath
		);
	}

	switch (env.connectionType) {
		case 'hawser-standard':
		case 'hawser-edge':
			return executeComposeViaHawser(
				operation,
				stackName,
				composeContent,
				envId!,
				envVars,
				secretVars,
				forceRecreate,
				removeVolumes,
				stackFiles
			);

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
				envPath
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
				envPath
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
	envVars?: Record<string, string>;
	secretVars?: Record<string, string>;
	needsFileLocation?: boolean;
	error?: string;
	/** Directory containing the compose file (for working directory) */
	stackDir?: string;
	/** Full path to the compose file (for imported stacks) */
	composePath?: string;
}

/**
 * Get compose file and env vars for stack operations.
 *
 * Returns:
 * - content: The compose file content
 * - envVars: Non-secret variables (from .env file, with DB fallback)
 * - secretVars: Secret variables (from DB only, for shell injection)
 * - needsFileLocation: true if stack needs user to specify file paths
 *
 * SECURITY: Secrets are NEVER written to .env files. They are stored in the database
 * and injected via shell environment variables at runtime.
 */
async function requireComposeFile(
	stackName: string,
	envId?: number | null
): Promise<RequireComposeResult> {
	const composeResult = await getStackComposeFile(stackName, envId);

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

	// Get non-secret variables from database (for backward compatibility)
	const dbNonSecretVars = await getNonSecretEnvVarsAsRecord(stackName, envId);

	// Read non-secret vars from .env file
	// For stacks with custom path, use the env path if set (and not empty string which means "no env file")
	// Otherwise, use the .env file in the stack directory
	let envFilePath: string | null = null;

	if (composeResult.composePath && composeResult.envPath) {
		// Custom compose path with explicit env path
		envFilePath = composeResult.envPath;
	} else if (composeResult.composePath && composeResult.envPath === '') {
		// Custom compose path with explicit "no env file" - don't read any file
		envFilePath = null;
	} else {
		// Default location - look for .env in stack directory
		const stackDir = composeResult.stackDir || await findStackDir(stackName, envId) || await getStackDir(stackName, envId);
		envFilePath = join(stackDir, '.env');
	}

	let fileEnvVars: Record<string, string> = {};

	if (envFilePath && existsSync(envFilePath)) {
		try {
			const content = await Bun.file(envFilePath).text();
			for (const line of content.split('\n')) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith('#')) continue;
				const eqIndex = trimmed.indexOf('=');
				if (eqIndex > 0) {
					const key = trimmed.substring(0, eqIndex).trim();
					let value = trimmed.substring(eqIndex + 1);
					if ((value.startsWith('"') && value.endsWith('"')) ||
					    (value.startsWith("'") && value.endsWith("'"))) {
						value = value.slice(1, -1);
					}
					fileEnvVars[key] = value;
				}
			}
		} catch {
			// Ignore file read errors
		}
	}

	// Merge non-secret vars: DB as fallback, file values override
	// This ensures external edits to .env are respected during deployment
	const envVars = { ...dbNonSecretVars, ...fileEnvVars };

	return {
		success: true,
		content: composeResult.content!,
		envVars,
		secretVars,
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
		result.envVars,
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

	return executeComposeCommand(
		'stop',
		{ stackName, envId, workingDir: result.stackDir, composePath: result.composePath, envPath: result.envPath },
		result.content!,
		result.envVars,
		result.secretVars
	);
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

	return executeComposeCommand(
		'restart',
		{ stackName, envId, workingDir: result.stackDir, composePath: result.composePath, envPath: result.envPath },
		result.content!,
		result.envVars,
		result.secretVars
	);
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

	return executeComposeCommand(
		'down',
		{ stackName, envId, removeVolumes, workingDir: result.stackDir, composePath: result.composePath, envPath: result.envPath },
		result.content!,
		result.envVars,
		result.secretVars
	);
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
		const composeResult = await getStackComposeFile(stackName);

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
		} else {
			// External stack - remove containers directly in parallel
			const { removeContainer } = await import('./docker.js');
			const stackContainers = await getStackContainers(stackName, envId);

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

		// Clean up database records - collect errors but don't stop
		const cleanupErrors: string[] = [];

		// Delete compose file and directory
		const stackDir = await findStackDir(stackName, envId) || await getStackDir(stackName, envId);
		if (existsSync(stackDir)) {
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
				deleteGitStackFiles(gitStack.id);
			}
			// Also cleanup any orphaned git stacks with NULL environment_id for this stack name
			if (envId !== undefined && envId !== null) {
				const orphanedGitStack = await getGitStackByName(stackName, null);
				if (orphanedGitStack) {
					await deleteGitStack(orphanedGitStack.id);
					deleteGitStackFiles(orphanedGitStack.id);
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
	const { name, compose, envId, envFileVars, sourceDir, forceRecreate, composePath, envPath, composeFileName, envFileName } = options;
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
	console.log(`${logPrefix} Env file vars provided:`, envFileVars ? Object.keys(envFileVars).length : 0);
	if (envFileVars && Object.keys(envFileVars).length > 0) {
		console.log(`${logPrefix} Env file var keys:`, Object.keys(envFileVars).join(', '));
		console.log(`${logPrefix} Env file vars (masked):`, JSON.stringify(maskSecrets(envFileVars), null, 2));
	}

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
				console.log(`${logPrefix} Actual compose path will be:`, actualComposePath);
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
			// Internal stack: compose file should already exist (written by saveStackComposeFile)
			// Just determine the working directory
			workingDir = await getStackDir(name, envId);
			console.log(`${logPrefix} Using internal stack directory:`, workingDir);
		}

		console.log(`${logPrefix} Compose content length:`, compose.length, 'chars');
		console.log(`${logPrefix} Compose content (full):`);
		console.log(compose);

		// Fetch stack environment variables from database (these are user overrides)
		const dbEnvVars = await getStackEnvVarsAsRecord(name, envId);
		console.log(`${logPrefix} DB env vars count:`, Object.keys(dbEnvVars).length);
		if (Object.keys(dbEnvVars).length > 0) {
			console.log(`${logPrefix} DB env var keys:`, Object.keys(dbEnvVars).join(', '));
			console.log(`${logPrefix} DB env vars (masked):`, JSON.stringify(maskSecrets(dbEnvVars), null, 2));
		}

		// Merge: env file vars as base, database overrides take precedence
		const envVars = { ...envFileVars, ...dbEnvVars };
		console.log(`${logPrefix} Merged env vars count:`, Object.keys(envVars).length);
		if (Object.keys(envVars).length > 0) {
			console.log(`${logPrefix} Merged env var keys:`, Object.keys(envVars).join(', '));
			console.log(`${logPrefix} Merged env vars (masked):`, JSON.stringify(maskSecrets(envVars), null, 2));
		}

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
				envPath: actualEnvPath
			},
			compose,
			envVars
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
		result.envVars,
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
	const envFilePath = customEnvPath
		? customEnvPath
		: join(await findStackDir(stackName, envId) || await getStackDir(stackName, envId), '.env');

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
	const envFilePath = customEnvPath
		? customEnvPath
		: join(await findStackDir(stackName, envId) || await getStackDir(stackName, envId), '.env');

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
