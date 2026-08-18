/**
 * Stack Git Engine.
 *
 * Sealed implementation of the per-stack git model: every git stack owns its
 * own full clone under git-repos/stack-<id> or git-repos/<envName>/<stack>,
 * re-cloned on every sync. Scheduled syncs and webhooks are per stack.
 *
 * The engine is SEALED — it imports only the low-level plumbing from git.ts
 * (buildGitEnv, execGit, cleanupSshKey, git-url-safety helpers, deletion-sync
 * helpers) and never shares path/sync helpers with the centralized engine (F5).
 * Containment checks backport HEAD's sep-aware `isPathUnderRoot` instead of
 * HEAD~1's `.startsWith` (N7).
 */

import { existsSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, basename, relative, isAbsolute } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import {
	getGitStack,
	getGitRepository,
	getGitCredential,
	updateGitStack,
	getEnvironment
} from './db';
import { assertSafeGitRef, repoFilePath } from './git-url-safety';
import { isPathUnderRoot } from './path-utils';
import { collectProcess } from './process-utils';
import {
	buildGitEnv,
	cleanupSshKey,
	buildRepoUrl,
	execGit,
	getChangedFilesInDir,
	computeSyncDeletionPlan,
	notifyGitSync,
	getGitReposDir,
	stackRepoPath,
	parseEnvFileContent,
	type SyncResult,
	type ProgressCallback,
	type DeployGitStackResult,
	type GitEngine
} from './git';
import { deployStackFromSync } from './git-deploy-shared';

// Generous per-clone bound: a frozen network/SSH connection must not hold a
// webhook/worker slot forever (the subprocess is SIGKILLed on timeout).
const STACK_CLONE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * In-flight stack-mode deploy counter. syncGitStack clears `syncStatus` to
 * 'synced' BEFORE the deploy phase runs (cpSync + docker compose), so the
 * transition drain cannot rely on that status column alone to detect a running
 * deploy. Mirrors the centralized engine's coalesce-slot count (F15).
 */
let activeStackDeploys = 0;
/** Stack ids with a stack-engine deploy in flight (per-selected-stack drain). */
const activeStackDeployIds = new Set<number>();

/** Number of stack-mode deploys currently in flight. Used by the migration drain. */
export function getActiveStackDeployCount(): number {
	return activeStackDeploys;
}

/** Stack ids with a stack-engine deploy in flight (per-stack migration drain). */
export function getActiveStackDeployIds(): number[] {
	return [...activeStackDeployIds];
}

/**
 * Stack (per-stack) clone path:
 *  - git-repos/stack-<id> (fallback / older stacks)
 *  - git-repos/<envName>/<stackName> (env-scoped, consistent with internal stacks)
 * Exported for the stack delete-preview route (upstream) to resolve the git dir
 * it will report as removed.
 */
export async function getStackRepoPath(stackId: number, stackName?: string, environmentId?: number | null): Promise<string> {
	if (stackName && environmentId) {
		// Use old path if it already exists (backward compat), otherwise use name-based path
		const oldPath = join(getGitReposDir(), `stack-${stackId}`);
		if (existsSync(oldPath)) {
			return oldPath;
		}
		// Format: envName/stackName (e.g. production/webapp) - consistent with internal stacks
		const env = await getEnvironment(environmentId);
		return stackRepoPath(stackId, env ? env.name : String(environmentId), stackName);
	}
	return stackRepoPath(stackId);
}

/**
 * Get the current commit hash from a repo path (if it exists).
 * Used to detect if repo was updated after re-clone.
 */
async function getPreviousCommit(repoPath: string, env: Record<string, string>): Promise<string | null> {
	if (!existsSync(repoPath)) {
		return null;
	}
	try {
		const result = await execGit(['rev-parse', 'HEAD'], repoPath, env);
		return result.code === 0 ? result.stdout.trim() : null;
	} catch {
		return null;
	}
}

export async function syncGitStack(stackId: number, _onProgress?: ProgressCallback): Promise<SyncResult> {
	const gitStack = await getGitStack(stackId);
	if (!gitStack) {
		return { success: false, error: 'Git stack not found' };
	}

	const logPrefix = `[Stack:${gitStack.stackName}]`;
	console.log(`${logPrefix} ========================================`);
	console.log(`${logPrefix} SYNC GIT STACK START`);
	console.log(`${logPrefix} ========================================`);
	console.log(`${logPrefix} Stack ID:`, stackId);
	console.log(`${logPrefix} Stack name:`, gitStack.stackName);
	console.log(`${logPrefix} Repository ID:`, gitStack.repositoryId);
	console.log(`${logPrefix} Compose path:`, gitStack.composePath);
	console.log(`${logPrefix} Env file path:`, gitStack.envFilePath || '(none)');
	console.log(`${logPrefix} Environment ID:`, gitStack.environmentId);

	// Check if sync is already in progress
	if (gitStack.syncStatus === 'syncing') {
		console.log(`${logPrefix} ERROR: Sync already in progress`);
		return { success: false, error: 'Sync already in progress' };
	}

	const repo = await getGitRepository(gitStack.repositoryId);
	if (!repo) {
		console.log(`${logPrefix} ERROR: Repository not found`);
		return { success: false, error: 'Repository not found' };
	}

	console.log(`${logPrefix} Repository URL:`, repo.url);
	console.log(`${logPrefix} Repository branch:`, repo.branch);

	const credential = repo.credentialId ? await getGitCredential(repo.credentialId) : null;
	const repoPath = await getStackRepoPath(stackId, gitStack.stackName, gitStack.environmentId);
	const env = await buildGitEnv(credential);

	console.log(`${logPrefix} Local repo path:`, repoPath);
	console.log(`${logPrefix} Has credential:`, !!credential);

	try {
		// Update sync status
		await updateGitStack(stackId, { syncStatus: 'syncing', syncError: null });

		let updated = false;
		let currentCommit = '';

		// Always re-clone to ensure clean state (handles branch/URL/credential changes, force pushes, etc.)
		// Blobless clones fetch all commits (for git diff) but download blobs on-demand
		// Fall back to DB lastCommit when repo dir was deleted by a previous failed sync (#693)
		const previousCommit = await getPreviousCommit(repoPath, env) ?? gitStack.lastCommit ?? null;
		if (existsSync(repoPath)) {
			console.log(`${logPrefix} Removing existing clone for fresh sync...`);
			rmSync(repoPath, { recursive: true, force: true });
		}

		console.log(`${logPrefix} Cloning repository...`);
		assertSafeGitRef(repo.branch);
		const repoUrl = buildRepoUrl(repo.url, credential);

		const result = await execGit(
			['clone', '--filter=blob:none', '--branch', repo.branch, repoUrl, repoPath],
			process.cwd(),
			env,
			STACK_CLONE_TIMEOUT_MS
		);
		console.log(`${logPrefix} Clone exit code:`, result.code);
		if (result.stdout) console.log(`${logPrefix} Clone stdout:`, result.stdout);
		if (result.stderr) console.log(`${logPrefix} Clone stderr:`, result.stderr);

		if (result.code !== 0) {
			// Clean up partial clone directory on failure
			if (existsSync(repoPath)) {
				rmSync(repoPath, { recursive: true, force: true });
			}
			throw new Error(`Git clone failed: ${result.stderr}`);
		}

		// Check if commit changed
		const newCommitResult = await execGit(['rev-parse', 'HEAD'], repoPath, env);
		const newCommit = newCommitResult.stdout.trim();
		// Normalize to 7-char short hash for comparison (DB stores 7-char, git returns 40-char)
		const commitChanged = previousCommit?.substring(0, 7) !== newCommit.substring(0, 7);
		console.log(`${logPrefix} Previous commit: ${previousCommit || '(none)'}, new commit: ${newCommit.substring(0, 7)}, commit changed: ${commitChanged}`);

		// Check if any files in the compose file's directory have changed
		// This catches changes to the compose file, env files, and any other referenced files
		// (e.g., config files, scripts, additional env files)
		let changedFiles: string[] = [];
		if (commitChanged) {
			// Use contextDir if set, otherwise fall back to compose file's directory
			const diffDirRelative = gitStack.contextDir || dirname(gitStack.composePath);
			console.log(`${logPrefix} Checking for changes in directory: ${diffDirRelative || '(root)'}`);

			const diffResult = await getChangedFilesInDir(
				repoPath,
				previousCommit,
				newCommit,
				diffDirRelative || '.',
				env
			);

			updated = diffResult.changed;
			changedFiles = diffResult.files;

			if (diffResult.error) {
				console.log(`${logPrefix} Diff error: ${diffResult.error}`);
			}

			if (changedFiles.length > 0) {
				console.log(`${logPrefix} Changed files (${changedFiles.length}):`);
				for (const file of changedFiles) {
					console.log(`${logPrefix}   - ${file}`);
				}
			} else {
				console.log(`${logPrefix} No files changed in stack directory`);
			}
		} else {
			updated = false;
			console.log(`${logPrefix} No commit change, skipping file diff`);
		}

		// Get current commit hash
		const commitResult = await execGit(['rev-parse', 'HEAD'], repoPath, env);
		currentCommit = commitResult.stdout.substring(0, 7);
		console.log(`${logPrefix} Current commit:`, currentCommit);

		// Read the compose file
		const composePath = repoFilePath(repoPath, gitStack.composePath, "Compose path");
		console.log(`${logPrefix} Reading compose file from:`, composePath);
		if (!existsSync(composePath)) {
			console.log(`${logPrefix} ERROR: Compose file not found at:`, composePath);
			throw new Error(`Compose file not found: ${gitStack.composePath}`);
		}

		const composeContent = readFileSync(composePath, 'utf-8');
		console.log(`${logPrefix} Compose content length:`, composeContent.length, 'chars');

		// Determine the source directory and compose filename
		// If contextDir is set, use it as the source directory (relative to repo root)
		// and compute composeFileName as relative path from contextDir to compose file
		let composeDir: string;
		let composeFileName: string;
		if (gitStack.contextDir) {
			const contextDirAbsolute = resolve(repoPath, gitStack.contextDir);
			// Validate: context dir must be within repo (sep-aware backport — N7)
			if (!isPathUnderRoot(contextDirAbsolute, repoPath)) {
				throw new Error('Context directory must be within the repository');
			}
			// Validate: compose file must be within context directory
			const relCompose = relative(contextDirAbsolute, composePath);
			if (relCompose.startsWith('..') || isAbsolute(relCompose)) {
				throw new Error('Compose file must be within the context directory');
			}
			composeDir = contextDirAbsolute;
			composeFileName = relCompose; // e.g., "apps/myapp/compose.yaml"
		} else {
			composeDir = dirname(composePath);
			composeFileName = basename(gitStack.composePath); // e.g., "docker-compose.yaml"
		}
		console.log(`${logPrefix} Source directory (composeDir):`, composeDir);
		console.log(`${logPrefix} Compose filename:`, composeFileName);

		// Read env file if configured (optional - don't fail if missing)
		let envFileVars: Record<string, string> | undefined;
		let envFileContent: string | undefined;
		let envFileName: string | undefined;
		if (gitStack.envFilePath) {
			const envFilePath = repoFilePath(repoPath, gitStack.envFilePath, "Env file path");
			console.log(`${logPrefix} Looking for env file at:`, envFilePath);
			if (existsSync(envFilePath)) {
				try {
					console.log(`${logPrefix} Reading env file...`);
					envFileContent = readFileSync(envFilePath, 'utf-8');
					envFileVars = parseEnvFileContent(envFileContent, gitStack.stackName);
					console.log(`${logPrefix} Env file parsed, vars count:`, Object.keys(envFileVars).length);

					// Compute env file path relative to compose directory
					// This is needed for --env-file flag after files are copied to stack directory
					envFileName = relative(composeDir, envFilePath);
					console.log(`${logPrefix} Env filename relative to compose dir:`, envFileName);
				} catch (err) {
					// Log but don't fail - env file is optional
					console.warn(`${logPrefix} Failed to read env file ${gitStack.envFilePath}:`, err);
				}
			} else {
				console.warn(`${logPrefix} Configured env file not found:`, gitStack.envFilePath);
			}
		} else {
			console.log(`${logPrefix} No env file path configured`);
		}

		// Deletion sync (#966): manifest-vs-clone deletion plan
		const deletionData = await computeSyncDeletionPlan({
			logPrefix,
			composeDir,
			composeFileName,
			rawManifest: gitStack.syncedFiles
		});

		// Update git stack status
		await updateGitStack(stackId, {
			syncStatus: 'synced',
			lastSync: new Date().toISOString(),
			lastCommit: currentCommit,
			syncError: null
		});

		cleanupSshKey(credential, env);

		console.log(`${logPrefix} ----------------------------------------`);
		console.log(`${logPrefix} SYNC GIT STACK COMPLETE`);
		console.log(`${logPrefix} ----------------------------------------`);
		console.log(`${logPrefix} Success: true`);
		console.log(`${logPrefix} Updated:`, updated);
		console.log(`${logPrefix} Changed files:`, changedFiles.length > 0 ? changedFiles.join(', ') : '(none)');
		console.log(`${logPrefix} Commit:`, currentCommit);
		console.log(`${logPrefix} Env file vars count:`, envFileVars ? Object.keys(envFileVars).length : 0);

		return {
			success: true,
			commit: currentCommit,
			composeContent,
			composeDir,
			composeFileName,
			envFileVars,
			envFileName,
			updated,
			changedFiles,
			deletionPlan: deletionData.plan,
			newFiles: deletionData.newFiles,
			newCommitFull: newCommit,
			previousManifest: deletionData.previousManifest
		};
	} catch (error: any) {
		cleanupSshKey(credential, env);
		await updateGitStack(stackId, {
			syncStatus: 'error',
			syncError: error.message
		});
		console.log(`${logPrefix} SYNC ERROR:`, error.message);
		return { success: false, error: error.message };
	}
}

export async function deployGitStack(
	stackId: number,
	options?: { force?: boolean; ignoreForceRedeploy?: boolean }
): Promise<DeployGitStackResult> {
	activeStackDeploys++;
	activeStackDeployIds.add(stackId);
	try {
		return await deployGitStackCore(stackId, options);
	} finally {
		activeStackDeploys--;
		activeStackDeployIds.delete(stackId);
	}
}

async function deployGitStackCore(
	stackId: number,
	options?: { force?: boolean; ignoreForceRedeploy?: boolean }
): Promise<DeployGitStackResult> {
	const force = options?.force ?? true; // Default to force for backward compatibility

	const gitStack = await getGitStack(stackId);
	if (!gitStack) {
		return { success: false, error: 'Git stack not found' };
	}

	const logPrefix = `[Stack:${gitStack.stackName}]`;
	console.log(`${logPrefix} ========================================`);
	console.log(`${logPrefix} DEPLOY GIT STACK START`);
	console.log(`${logPrefix} ========================================`);
	console.log(`${logPrefix} Stack ID:`, stackId);
	console.log(`${logPrefix} Force deploy:`, force);

	// Sync first
	console.log(`${logPrefix} Syncing git repository...`);
	const syncResult = await syncGitStack(stackId);
	if (!syncResult.success) {
		console.log(`${logPrefix} Sync failed:`, syncResult.error);
		const failResult = { success: false, error: syncResult.error };
		await notifyGitSync(gitStack.stackName, gitStack.environmentId, failResult);
		return failResult;
	}

	console.log(`${logPrefix} Sync successful`);
	console.log(`${logPrefix} Sync result - updated:`, syncResult.updated);
	console.log(`${logPrefix} Sync result - commit:`, syncResult.commit);
	console.log(`${logPrefix} Sync result - env file vars:`, syncResult.envFileVars ? Object.keys(syncResult.envFileVars).length : 0);
	if (syncResult.envFileVars && Object.keys(syncResult.envFileVars).length > 0) {
		console.log(`${logPrefix} Env file var keys:`, Object.keys(syncResult.envFileVars).join(', '));
	}

	// Deploy using the shared post-sync body (git-deploy-shared.ts).
	return deployStackFromSync({ stackId, gitStack, opts: { force, ignoreForceRedeploy: false }, syncResult, logPrefix });
}

export async function deleteGitStackFiles(stackId: number, stackName?: string, environmentId?: number | null): Promise<void> {
	const repoPath = await getStackRepoPath(stackId, stackName, environmentId);
	try {
		if (existsSync(repoPath)) {
			rmSync(repoPath, { recursive: true, force: true });
		}
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error('[Git] Failed to delete git stack files:', errorMsg);
	}
}

export async function deployGitStackWithProgress(
	stackId: number,
	onProgress: ProgressCallback
): Promise<DeployGitStackResult> {
	activeStackDeploys++;
	activeStackDeployIds.add(stackId);
	try {
		return await deployGitStackWithProgressCore(stackId, onProgress);
	} finally {
		activeStackDeploys--;
		activeStackDeployIds.delete(stackId);
	}
}

async function deployGitStackWithProgressCore(
	stackId: number,
	onProgress: ProgressCallback
): Promise<DeployGitStackResult> {
	const gitStack = await getGitStack(stackId);
	if (!gitStack) {
		onProgress({ status: 'error', error: 'Git stack not found' });
		return { success: false, error: 'Git stack not found' };
	}

	// Check if sync is already in progress
	if (gitStack.syncStatus === 'syncing') {
		onProgress({ status: 'error', error: 'Sync already in progress' });
		return { success: false, error: 'Sync already in progress' };
	}

	const repo = await getGitRepository(gitStack.repositoryId);
	if (!repo) {
		onProgress({ status: 'error', error: 'Repository not found' });
		return { success: false, error: 'Repository not found' };
	}

	const credential = repo.credentialId ? await getGitCredential(repo.credentialId) : null;
	const repoPath = await getStackRepoPath(stackId, gitStack.stackName, gitStack.environmentId);
	const env = await buildGitEnv(credential);

	const totalSteps = 5;

	try {
		// Step 1: Connecting
		onProgress({ status: 'connecting', message: 'Connecting to repository...', step: 1, totalSteps });
		await updateGitStack(stackId, { syncStatus: 'syncing', syncError: null });

		let updated = false;
		let currentCommit = '';

		// Always re-clone to ensure clean state (handles branch/URL/credential changes, force pushes, etc.)
		// Shallow clones are fast so this is acceptable
		// Fall back to DB lastCommit when repo dir was deleted by a previous failed sync (#693)
		const previousCommit = await getPreviousCommit(repoPath, env) ?? gitStack.lastCommit ?? null;

		// Step 2: Cloning
		onProgress({ status: 'cloning', message: 'Cloning repository...', step: 2, totalSteps });

		if (existsSync(repoPath)) {
			rmSync(repoPath, { recursive: true, force: true });
		}

		assertSafeGitRef(repo.branch);
		const repoUrl = buildRepoUrl(repo.url, credential);

		// Step 3: Fetching (blobless clone - fetches all commits but blobs on-demand)
		onProgress({ status: 'fetching', message: `Fetching branch ${repo.branch}...`, step: 3, totalSteps });
		const cloneResult = await execGit(
			['clone', '--filter=blob:none', '--branch', repo.branch, repoUrl, repoPath],
			process.cwd(),
			env,
			STACK_CLONE_TIMEOUT_MS
		);
		if (cloneResult.code !== 0) {
			// Clean up partial clone directory on failure
			if (existsSync(repoPath)) {
				rmSync(repoPath, { recursive: true, force: true });
			}
			throw new Error(`Git clone failed: ${cloneResult.stderr}`);
		}

		// Check if commit changed
		const newCommitResult = await execGit(['rev-parse', 'HEAD'], repoPath, env);
		const newCommit = newCommitResult.stdout.trim();
		// Normalize to 7-char short hash for comparison (DB stores 7-char, git returns 40-char)
		const commitChanged = previousCommit?.substring(0, 7) !== newCommit.substring(0, 7);

		// Check if any files in the context/compose directory have changed
		// (for consistency with syncGitStack, though this function always deploys)
		if (commitChanged) {
			const diffDir = gitStack.contextDir || dirname(gitStack.composePath);
			const diffResult = await getChangedFilesInDir(
				repoPath,
				previousCommit,
				newCommit,
				diffDir || '.',
				env
			);
			updated = diffResult.changed;
		} else {
			updated = false;
		}

		// Get current commit hash
		const commitResult = await execGit(['rev-parse', 'HEAD'], repoPath, env);
		currentCommit = commitResult.stdout.substring(0, 7);

		// Step 4: Reading compose file
		onProgress({ status: 'reading', message: `Reading ${gitStack.composePath}...`, step: 4, totalSteps });
		const composePath = repoFilePath(repoPath, gitStack.composePath, "Compose path");
		if (!existsSync(composePath)) {
			throw new Error(`Compose file not found: ${gitStack.composePath}`);
		}

		const composeContent = readFileSync(composePath, 'utf-8');

		// Determine the source directory and compose filename
		let composeDir: string;
		let progressComposeFileName: string;
		if (gitStack.contextDir) {
			const contextDirAbsolute = resolve(repoPath, gitStack.contextDir);
			// Sep-aware containment backport (N7)
			if (!isPathUnderRoot(contextDirAbsolute, repoPath)) {
				throw new Error('Context directory must be within the repository');
			}
			const relCompose = relative(contextDirAbsolute, composePath);
			if (relCompose.startsWith('..')) {
				throw new Error('Compose file must be within the context directory');
			}
			composeDir = contextDirAbsolute;
			progressComposeFileName = relCompose;
		} else {
			composeDir = dirname(composePath);
			progressComposeFileName = basename(gitStack.composePath);
		}

		// Read env file if configured (optional - don't fail if missing)
		let envFileVars: Record<string, string> | undefined;
		if (gitStack.envFilePath) {
			const envFilePath = repoFilePath(repoPath, gitStack.envFilePath, "Env file path");
			if (existsSync(envFilePath)) {
				try {
					const envContent = readFileSync(envFilePath, 'utf-8');
					envFileVars = parseEnvFileContent(envContent, gitStack.stackName);
				} catch (err) {
					// Log but don't fail - env file is optional
					console.warn(`Failed to read env file ${gitStack.envFilePath}:`, err);
				}
			} else {
				console.warn(`Configured env file not found: ${gitStack.envFilePath}`);
			}
		}

		// Deletion sync (#966): manifest-vs-clone deletion plan
		const logPrefix = `[Stack:${gitStack.stackName}]`;
		const deletionData = await computeSyncDeletionPlan({
			logPrefix,
			composeDir,
			composeFileName: progressComposeFileName,
			rawManifest: gitStack.syncedFiles
		});

		// Update git stack status
		await updateGitStack(stackId, {
			syncStatus: 'synced',
			lastSync: new Date().toISOString(),
			lastCommit: currentCommit,
			syncError: null
		});

		cleanupSshKey(credential, env);

		// Determine env filename relative to compose dir (same logic as syncGitStack)
		let envFileName: string | undefined;
		if (gitStack.envFilePath) {
			const envFilePath = repoFilePath(repoPath, gitStack.envFilePath, "Env file path");
			if (existsSync(envFilePath)) {
				envFileName = relative(composeDir, envFilePath);
			}
		}

		// Deploy using the shared post-sync body (git-deploy-shared.ts): it emits
		// the change-table + deploy progress, runs docker compose, finalizes the
		// deletion sync, records the stack source, rolls back lastCommit on
		// failure, and emits the single git_sync_* notification.
		const syncResult: SyncResult = {
			success: true,
			commit: currentCommit,
			composeContent,
			composeDir,
			composeFileName: progressComposeFileName,
			envFileVars,
			envFileName,
			updated,
			deletionPlan: deletionData.plan,
			newFiles: deletionData.newFiles,
			newCommitFull: newCommit,
			previousManifest: deletionData.previousManifest
		};
		return deployStackFromSync({ stackId, gitStack, opts: { force: true, ignoreForceRedeploy: false }, syncResult, onProgress, logPrefix });
	} catch (error: any) {
		cleanupSshKey(credential, env);
		await updateGitStack(stackId, {
			syncStatus: 'error',
			syncError: error.message
		});
		onProgress({ status: 'error', error: error.message });
		await notifyGitSync(gitStack.stackName, gitStack.environmentId, { success: false, error: error.message });
		return { success: false, error: error.message };
	}
}

// =============================================================================
// ENV FILE OPERATIONS (stack mode: reads the per-stack clone)
// =============================================================================

/**
 * List all .env* files in a git stack's repository.
 * Returns relative paths from the repository root.
 */
export async function listGitStackEnvFiles(stackId: number): Promise<{ files: string[]; error?: string }> {
	const gitStack = await getGitStack(stackId);
	if (!gitStack) {
		return { files: [], error: 'Git stack not found' };
	}

	const repoPath = await getStackRepoPath(stackId, gitStack.stackName, gitStack.environmentId);
	if (!existsSync(repoPath)) {
		return { files: [], error: 'Repository not synced - deploy the stack first' };
	}

	try {
		// Find all .env* files recursively (but not too deep)
		const maxDepth = 3;

		// Use find to locate all .env* files
		const proc = nodeSpawn('find', [repoPath, '-maxdepth', String(maxDepth), '-type', 'f', '-name', '.env*'], {
			stdio: ['pipe', 'pipe', 'pipe']
		});
		const findResult = await collectProcess(proc);
		const output = findResult.stdout;

		const files = output.trim().split('\n').filter(f => f);
		const envFiles: string[] = [];

		for (const file of files) {
			// Convert absolute path to relative from repo root
			const relativePath = file.replace(repoPath + '/', '');
			// Skip files in node_modules or .git directories
			if (!relativePath.includes('node_modules/') && !relativePath.includes('.git/')) {
				envFiles.push(relativePath);
			}
		}

		return { files: envFiles.sort() };
	} catch (error: any) {
		return { files: [], error: error.message };
	}
}

/**
 * Read and parse a .env file from a git stack's repository.
 * Containment check backports HEAD's sep-aware isPathUnderRoot (N7).
 */
export async function readGitStackEnvFile(
	stackId: number,
	envFilePath: string
): Promise<{ vars: Record<string, string>; error?: string }> {
	const gitStack = await getGitStack(stackId);
	if (!gitStack) {
		return { vars: {}, error: 'Git stack not found' };
	}

	const repoPath = await getStackRepoPath(stackId, gitStack.stackName, gitStack.environmentId);
	if (!existsSync(repoPath)) {
		return { vars: {}, error: 'Repository not synced - deploy the stack first' };
	}

	// Security check: ensure the path doesn't escape the repo (lexical + realpath
	// containment, so a malicious repo cannot exfiltrate host files).
	const fullPath = resolve(repoPath, envFilePath);
	if (!isPathUnderRoot(fullPath, repoPath)) {
		return { vars: {}, error: 'Invalid file path' };
	}

	if (!existsSync(fullPath)) {
		return { vars: {}, error: `File not found: ${envFilePath}` };
	}

	// Realpath containment check, so a git-tracked symlink pointing outside the
	// repo cannot exfiltrate host files through the env-file reader.
	let realPath: string;
	try {
		realPath = realpathSync(fullPath);
		if (!isPathUnderRoot(realPath, realpathSync(repoPath))) {
			return { vars: {}, error: 'Invalid file path' };
		}
	} catch {
		return { vars: {}, error: `File not found: ${envFilePath}` };
	}

	try {
		const content = readFileSync(realPath, 'utf-8');
		const vars = parseEnvFileContent(content);
		return { vars };
	} catch (error: any) {
		return { vars: {}, error: error.message };
	}
}

// =============================================================================
// ENGINE EXPORT
// =============================================================================

export const StackGitEngine: GitEngine = {
	syncGitStack,
	deployGitStack,
	deployGitStackWithProgress,
	deleteGitStackFiles,
	listGitStackEnvFiles,
	readGitStackEnvFile
};
