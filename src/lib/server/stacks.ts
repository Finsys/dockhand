/**
 * Stack Management Module
 *
 * Provides compose-first stack operations for internal, git, and external stacks.
 * All lifecycle operations use docker compose commands.
 */

import { existsSync, mkdirSync, rmSync, readdirSync, cpSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
	getEnvironment,
	getStackEnvVarsAsRecord,
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

// =============================================================================
// TYPES
// =============================================================================

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
}

// =============================================================================
// ERRORS
// =============================================================================

/**
 * Error for operations on external stacks without compose files
 */
export class ExternalStackError extends Error {
	public readonly stackName: string;

	constructor(stackName: string) {
		super(
			`Stack "${stackName}" was created outside of Dockhand. ` +
				`To manage this stack, first import it by clicking the Import button in the stack menu.`
		);
		this.name = 'ExternalStackError';
		this.stackName = stackName;
	}
}

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
			const composeYml = join(stacksDir, dirent.name, 'docker-compose.yml');
			const composeYaml = join(stacksDir, dirent.name, 'docker-compose.yaml');
			return existsSync(composeYml) || existsSync(composeYaml);
		})
		.map((dirent) => dirent.name);
}

// =============================================================================
// COMPOSE FILE MANAGEMENT
// =============================================================================

/**
 * Get compose file content for a stack
 */
export async function getStackComposeFile(
	stackName: string
): Promise<{ success: boolean; content?: string; error?: string }> {
	const stacksDir = getStacksDir();
	const stackDir = join(stacksDir, stackName);
	const composeFile = join(stackDir, 'docker-compose.yml');

	const ymlFile = Bun.file(composeFile);
	if (await ymlFile.exists()) {
		return {
			success: true,
			content: await ymlFile.text()
		};
	}

	const yamlFile = Bun.file(join(stackDir, 'docker-compose.yaml'));
	if (await yamlFile.exists()) {
		return {
			success: true,
			content: await yamlFile.text()
		};
	}

	return {
		success: false,
		error: `Compose file not found for stack "${stackName}". The stack may have been created outside of Dockhand.`
	};
}

/**
 * Save or create a stack compose file without deploying.
 * @param name - Stack name
 * @param content - Compose file content
 * @param create - If true, creates a new stack (fails if exists). If false, updates existing (fails if not exists).
 */
export async function saveStackComposeFile(
	name: string,
	content: string,
	create = false
): Promise<{ success: boolean; error?: string }> {
	// Validate stack name
	if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
		return {
			success: false,
			error: 'Stack name can only contain letters, numbers, hyphens, and underscores'
		};
	}

	const stacksDir = getStacksDir();
	const stackDir = join(stacksDir, name);
	const composeFile = join(stackDir, 'docker-compose.yml');
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
	} else {
		// Updating existing stack - must exist
		if (!exists) {
			return { success: false, error: `Stack "${name}" not found` };
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
// COMPOSE COMMAND EXECUTION
// =============================================================================

interface ComposeCommandOptions {
	stackName: string;
	envId?: number | null;
	forceRecreate?: boolean;
	removeVolumes?: boolean;
	stackFiles?: Record<string, string>; // All files to send to Hawser
}

/**
 * Execute a docker compose command locally via Bun.spawn
 */
async function executeLocalCompose(
	operation: 'up' | 'down' | 'stop' | 'start' | 'restart' | 'pull',
	stackName: string,
	composeContent: string,
	dockerHost?: string,
	envVars?: Record<string, string>,
	forceRecreate?: boolean,
	removeVolumes?: boolean
): Promise<StackOperationResult> {
	const logPrefix = `[Stack:${stackName}]`;
	const stacksDir = getStacksDir();
	const stackDir = join(stacksDir, stackName);
	mkdirSync(stackDir, { recursive: true });

	const composeFile = join(stackDir, 'docker-compose.yml');
	await Bun.write(composeFile, composeContent);

	// Note: .env file is written when env vars are saved via API
	// Docker compose automatically reads .env from the stack directory
	// We only need to pass env vars to process environment for variable substitution
	// in case the .env file doesn't exist yet (e.g., first deploy)
	const spawnEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
	if (dockerHost) {
		spawnEnv.DOCKER_HOST = dockerHost;
	}
	if (envVars) {
		Object.assign(spawnEnv, envVars);
	}

	// Build command based on operation
	const args = ['docker', 'compose', '-p', stackName, '-f', composeFile];

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

	try {
		console.log(`${logPrefix} Spawning docker compose process...`);
		const proc = Bun.spawn(args, {
			cwd: stackDir,
			env: spawnEnv,
			stdout: 'pipe',
			stderr: 'pipe'
		});

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
	}
}

/**
 * Execute a docker compose command via Hawser agent
 */
async function executeComposeViaHawser(
	operation: 'up' | 'down' | 'stop' | 'start' | 'restart' | 'pull',
	stackName: string,
	composeContent: string,
	envId: number,
	envVars?: Record<string, string>,
	forceRecreate?: boolean,
	removeVolumes?: boolean,
	stackFiles?: Record<string, string>
): Promise<StackOperationResult> {
	const logPrefix = `[Stack:${stackName}]`;
	// Import dockerFetch dynamically to avoid circular dependency
	const { dockerFetch } = await import('./docker.js');

	console.log(`${logPrefix} ----------------------------------------`);
	console.log(`${logPrefix} EXECUTE COMPOSE VIA HAWSER`);
	console.log(`${logPrefix} ----------------------------------------`);
	console.log(`${logPrefix} Operation:`, operation);
	console.log(`${logPrefix} Environment ID:`, envId);
	console.log(`${logPrefix} Force recreate:`, forceRecreate ?? false);
	console.log(`${logPrefix} Remove volumes:`, removeVolumes ?? false);
	console.log(`${logPrefix} Env vars count:`, envVars ? Object.keys(envVars).length : 0);
	if (envVars && Object.keys(envVars).length > 0) {
		console.log(`${logPrefix} Env vars being sent (masked):`, JSON.stringify(maskSecrets(envVars), null, 2));
	}
	console.log(`${logPrefix} Compose content length:`, composeContent.length, 'chars');
	console.log(`${logPrefix} Stack files count:`, stackFiles ? Object.keys(stackFiles).length : 0);
	if (stackFiles && Object.keys(stackFiles).length > 0) {
		console.log(`${logPrefix} Stack files:`, Object.keys(stackFiles).join(', '));
	}

	try {
		// Build files map - include .env file if envVars provided
		const files: Record<string, string> = { ...(stackFiles || {}) };
		if (envVars && Object.keys(envVars).length > 0) {
			const envContent = Object.entries(envVars)
				.map(([key, value]) => `${key}=${value}`)
				.join('\n');
			files['.env'] = envContent;
			console.log(`${logPrefix} Added .env file to files map with ${Object.keys(envVars).length} variables`);
		}

		const body = JSON.stringify({
			operation,
			projectName: stackName,
			composeFile: composeContent,
			envVars: envVars || {},
			files, // All files including .env
			forceRecreate: forceRecreate || false,
			removeVolumes: removeVolumes || false
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
 * Route compose command to appropriate executor based on connection type
 */
async function executeComposeCommand(
	operation: 'up' | 'down' | 'stop' | 'start' | 'restart' | 'pull',
	options: ComposeCommandOptions,
	composeContent: string,
	envVars?: Record<string, string>
): Promise<StackOperationResult> {
	const { stackName, envId, forceRecreate, removeVolumes, stackFiles } = options;

	// Get environment configuration
	const env = envId ? await getEnvironment(envId) : null;

	if (!env) {
		// Local socket connection (no environment specified)
		return executeLocalCompose(
			operation,
			stackName,
			composeContent,
			undefined,
			envVars,
			forceRecreate,
			removeVolumes
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
				forceRecreate,
				removeVolumes,
				stackFiles
			);

		case 'direct': {
			const port = env.port || 2375;
			const dockerHost = `tcp://${env.host}:${port}`;
			return executeLocalCompose(
				operation,
				stackName,
				composeContent,
				dockerHost,
				envVars,
				forceRecreate,
				removeVolumes
			);
		}

		case 'socket':
		default:
			return executeLocalCompose(
				operation,
				stackName,
				composeContent,
				undefined,
				envVars,
				forceRecreate,
				removeVolumes
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
 * Ensure we have a compose file for operations, throw appropriate error if not
 */
async function requireComposeFile(
	stackName: string,
	envId?: number | null
): Promise<{ content: string; envVars: Record<string, string> }> {
	const composeResult = await getStackComposeFile(stackName);

	if (!composeResult.success) {
		// Check if this is an external stack
		const source = await getStackSource(stackName, envId);
		if (!source || source.sourceType === 'external') {
			throw new ExternalStackError(stackName);
		}
		throw new ComposeFileNotFoundError(stackName);
	}

	// Get environment variables from database
	const dbEnvVars = await getStackEnvVarsAsRecord(stackName, envId);

	// Also read from .env file and merge (file + DB are equal sources)
	// DB values take precedence for secrets, file values for new/changed vars
	const stackDir = join(getStacksDir(), stackName);
	const envFilePath = join(stackDir, '.env');
	let fileEnvVars: Record<string, string> = {};

	if (existsSync(envFilePath)) {
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

	// Merge: file values as base, DB values override (DB is authoritative for managed vars)
	const envVars = { ...fileEnvVars, ...dbEnvVars };

	return { content: composeResult.content!, envVars };
}

/**
 * Start a stack using docker compose up
 * Falls back to individual container start for external stacks
 */
export async function startStack(
	stackName: string,
	envId?: number | null
): Promise<StackOperationResult> {
	try {
		const { content, envVars } = await requireComposeFile(stackName, envId);
		return executeComposeCommand('up', { stackName, envId }, content, envVars);
	} catch (err) {
		if (err instanceof ExternalStackError) {
			return withContainerFallback(stackName, envId, 'start');
		}
		throw err;
	}
}

/**
 * Stop a stack using docker compose stop
 * Falls back to individual container stop for external stacks
 */
export async function stopStack(
	stackName: string,
	envId?: number | null
): Promise<StackOperationResult> {
	try {
		const { content, envVars } = await requireComposeFile(stackName, envId);
		return executeComposeCommand('stop', { stackName, envId }, content, envVars);
	} catch (err) {
		if (err instanceof ExternalStackError) {
			return withContainerFallback(stackName, envId, 'stop');
		}
		throw err;
	}
}

/**
 * Restart a stack using docker compose restart
 * Falls back to individual container restart for external stacks
 */
export async function restartStack(
	stackName: string,
	envId?: number | null
): Promise<StackOperationResult> {
	try {
		const { content, envVars } = await requireComposeFile(stackName, envId);
		return executeComposeCommand('restart', { stackName, envId }, content, envVars);
	} catch (err) {
		if (err instanceof ExternalStackError) {
			return withContainerFallback(stackName, envId, 'restart');
		}
		throw err;
	}
}

/**
 * Down a stack using docker compose down (removes containers, keeps files)
 * For external stacks, this is equivalent to stop (no compose file to "down")
 */
export async function downStack(
	stackName: string,
	envId?: number | null,
	removeVolumes = false
): Promise<StackOperationResult> {
	try {
		const { content, envVars } = await requireComposeFile(stackName, envId);
		return executeComposeCommand('down', { stackName, envId, removeVolumes }, content, envVars);
	} catch (err) {
		if (err instanceof ExternalStackError) {
			// For external stacks, down is the same as stop (no compose file to tear down)
			return withContainerFallback(stackName, envId, 'stop');
		}
		throw err;
	}
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
			const envVars = await getStackEnvVarsAsRecord(stackName, envId);
			const downResult = await executeComposeCommand(
				'down',
				{ stackName, envId },
				composeResult.content!,
				envVars
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
		const stacksDir = getStacksDir();
		const stackDir = join(stacksDir, stackName);
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
	const { name, compose, envId, envFileVars, sourceDir, forceRecreate } = options;
	const logPrefix = `[Stack:${name}]`;

	console.log(`${logPrefix} ========================================`);
	console.log(`${logPrefix} DEPLOY STACK START`);
	console.log(`${logPrefix} ========================================`);
	console.log(`${logPrefix} Environment ID:`, envId ?? '(none - local)');
	console.log(`${logPrefix} Force recreate:`, forceRecreate ?? false);
	console.log(`${logPrefix} Source directory:`, sourceDir ?? '(none)');
	console.log(`${logPrefix} Env file vars provided:`, envFileVars ? Object.keys(envFileVars).length : 0);
	if (envFileVars && Object.keys(envFileVars).length > 0) {
		console.log(`${logPrefix} Env file var keys:`, Object.keys(envFileVars).join(', '));
		console.log(`${logPrefix} Env file vars (masked):`, JSON.stringify(maskSecrets(envFileVars), null, 2));
	}

	// Validate stack name
	if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
		console.log(`${logPrefix} ERROR: Invalid stack name format`);
		return {
			success: false,
			output: '',
			error: 'Stack name can only contain letters, numbers, hyphens, and underscores'
		};
	}

	return withStackLock(name, async () => {
		const stacksDir = getStacksDir();
		const stackDir = join(stacksDir, name);

		// Read all files from source directory if provided (for Hawser deployments)
		let stackFiles: Record<string, string> | undefined;
		if (sourceDir && existsSync(sourceDir)) {
			stackFiles = await readDirFilesAsMap(sourceDir);
			console.log(`${logPrefix} Read ${Object.keys(stackFiles).length} files from source directory`);
			console.log(`${logPrefix} Files:`, Object.keys(stackFiles).join(', '));
		}

		// Handle stack directory setup
		if (sourceDir && existsSync(sourceDir)) {
			// Copy entire source directory to stack directory (for git stacks)
			console.log(`${logPrefix} Copying source directory to stack directory...`);
			if (existsSync(stackDir)) {
				rmSync(stackDir, { recursive: true, force: true });
			}
			cpSync(sourceDir, stackDir, { recursive: true });
			console.log(`${logPrefix} Copied ${sourceDir} -> ${stackDir}`);
		} else {
			// Traditional behavior: create directory and write compose file only
			mkdirSync(stackDir, { recursive: true });
			const composeFile = join(stackDir, 'docker-compose.yml');
			await Bun.write(composeFile, compose);
			console.log(`${logPrefix} Compose file written to:`, composeFile);
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
		const result = await executeComposeCommand('up', { stackName: name, envId, forceRecreate, stackFiles }, compose, envVars);
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
	const { content, envVars } = await requireComposeFile(stackName, envId);

	return executeComposeCommand('pull', { stackName, envId }, content, envVars);
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
	variables: { key: string; value: string; isSecret?: boolean }[]
): Promise<void> {
	const stacksDir = getStacksDir();
	const envFilePath = join(stacksDir, stackName, '.env');

	const rawContent = variables
		.filter(v => v.key?.trim())
		.map(v => `${v.key.trim()}=${v.value}`)
		.join('\n') + '\n';

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
	envId?: number | null
): Promise<void> {
	// Save to database for secret tracking
	await saveStackEnvVarsToDb(stackName, variables, envId);
	// Write .env file to disk for Docker Compose
	await writeStackEnvFile(stackName, variables);
}

// =============================================================================
// RE-EXPORTS FOR BACKWARDS COMPATIBILITY
// =============================================================================

// These exports maintain API compatibility with code that imports from docker.ts
// They can be removed once all imports are updated

export type { StackOperationResult as CreateStackResult };
