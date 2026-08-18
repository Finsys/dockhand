/**
 * Centralized Git Engine.
 *
 * Sealed implementation of the "centralized" git repository model (HEAD
 * behaviour): one shared clone per repository under git-repos/shared/<name>,
 * repository-level sync/webhooks and per-stack fan-out. It shares only the
 * low-level plumbing in git.ts (buildGitEnv, execGit, deletion-sync helpers,
 * notifications) — never path or sync helpers with the stack engine (F5).
 */

import { existsSync, rmSync, readFileSync, realpathSync, renameSync } from 'node:fs';
import { join, resolve, dirname, basename, relative, isAbsolute } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import {
	getGitRepository,
	getGitRepositories,
	getGitCredential,
	updateGitRepository,
	getGitStack,
	updateGitStack,
	getFullGitStacksByRepositoryId,
	type GitCredential
} from './db';
import { assertSafeGitRef, repoFilePath } from './git-url-safety';
import { isPathUnderRoot } from './path-utils';
import { filterCentralizedStacks } from '../utils/git-model-routing';
import { collectProcess } from './process-utils';
import { redactEnvVarsForLog } from './log-utils';
import {
	mergeDeployGitStackOpts,
	fanOutDeployStacks,
	mergeFanOutStackIds,
	type DeployGitStackOpts
} from '../utils/git-deploy-gating';
import { runCoalesced, type CoalesceSlot } from './coalesce';
import { Semaphore } from './semaphore';
import {
	buildGitEnv,
	cleanupSshKey,
	buildRepoUrl,
	execGit,
	getChangedFilesInDir,
	computeSyncDeletionPlan,
	notifyGitSync,
	getRepoPath,
	getGitReposDir,
	sanitizeRepoName,
	parseEnvFileContent,
	type SyncResult,
	type ProgressCallback,
	type DeployGitStackResult,
	type FanOutResult,
	type GitEngine,
	type GitMode
} from './git';
import { deployStackFromSync } from './git-deploy-shared';
import { getGitMode } from './git-mode';

// Generous per-clone bound: a frozen network/SSH connection must not wedge the
// transition drain or hold a worker slot forever (SIGKILLed on timeout).
const CENTRALIZED_CLONE_TIMEOUT_MS = 10 * 60 * 1000;

// Global cap on concurrent repo syncs (each runs git clone/fetch subprocesses).
const REPO_SYNC_CONCURRENCY = 4;

// =============================================================================
// ENV-SCOPED GIT-REPOS CLEANUP (mode-gated — F10)
// =============================================================================

/**
 * The stack-mode layout stored per-environment clones under git-repos/<envName>/.
 * Centralized clones live under git-repos/shared/, so an env tree never
 * contains a top-level .git. The heuristic is kept conservative: it also
 * refuses preview-/repo- prefixed dirs.
 */
function isEnvGitReposDir(dir: string): boolean {
	if (!existsSync(dir)) return false;
	if (existsSync(join(dir, '.git'))) return false;
	const base = basename(dir);
	if (base.startsWith('preview-') || base.startsWith('repo-') || base === 'shared') return false;
	return true;
}

/** Remove a leftover per-environment git-repos directory, if present. */
export function cleanupEnvGitReposDir(envName: string): void {
	const dir = join(getGitReposDir(), envName);
	if (dir === getGitReposDir() || !dir.startsWith(getGitReposDir() + '/')) return;
	if (!isEnvGitReposDir(dir)) return;
	try {
		rmSync(dir, { recursive: true, force: true });
		console.log(`[Git] Removed env-scoped git-repos dir: ${dir}`);
	} catch (err) {
		console.warn(`[Git] Failed to remove env-scoped git-repos dir ${dir}:`, err);
	}
}

// =============================================================================
// REPOSITORY-LEVEL OPERATIONS (shared clone under git-repos/shared/<name>)
// =============================================================================

export async function syncRepository(repoId: number): Promise<SyncResult> {
	const repo = await getGitRepository(repoId);
	if (!repo) {
		return { success: false, error: 'Repository not found' };
	}

	const credential = repo.credentialId ? await getGitCredential(repo.credentialId) : null;
	const repoPath = getRepoPath(repo.name);
	// Migrate pre-shared clone directories to the shared/ namespace on first access:
	//  - repo-{id} (oldest layout)
	//  - git-repos/<sanitizedRepoName> (pre-shared centralized layout)
	// Only a directory that is actually a git clone (has a top-level .git) is
	// moved — an env-scoped dir (git-repos/<envName>/) must never be relocated
	// into shared/. `shared/` is created at startup (git-paths.ts), so the
	// rename target's parent always exists.
	const migratePreSharedClone = async (oldPath: string): Promise<void> => {
		if (!existsSync(oldPath) || existsSync(repoPath) || oldPath === repoPath) return;
		if (!existsSync(join(oldPath, '.git'))) return; // not a clone — leave it
		try {
			renameSync(oldPath, repoPath);
			console.log(`[Git] Migrated repo dir ${oldPath} -> ${repoPath}`);
		} catch (err) {
			console.warn(`[Git] Failed to migrate repo dir, will clone fresh:`, err);
		}
	};
	await migratePreSharedClone(join(getGitReposDir(), `repo-${repoId}`));
	await migratePreSharedClone(join(getGitReposDir(), sanitizeRepoName(repo.name)));
	const env = await buildGitEnv(credential);

	try {
		// Update sync status
		await updateGitRepository(repoId, { syncStatus: 'syncing', syncError: null });

		let updated = false;
		let currentCommit = '';

		if (!existsSync(repoPath) || !existsSync(join(repoPath, '.git'))) {
			// Missing or incomplete clone (e.g. interrupted clone left a directory
			// without .git) — remove residue and clone fresh.
			if (existsSync(repoPath)) {
				rmSync(repoPath, { recursive: true, force: true });
			}
			assertSafeGitRef(repo.branch);
			const repoUrl = buildRepoUrl(repo.url, credential);

			const result = await execGit(
				['clone', '--filter=blob:none', '--branch', repo.branch, repoUrl, repoPath],
				process.cwd(),
				env,
				CENTRALIZED_CLONE_TIMEOUT_MS
			);
			if (result.code !== 0) {
				// Clean up partial clone directory on failure
				if (existsSync(repoPath)) {
					rmSync(repoPath, { recursive: true, force: true });
				}
				throw new Error(`Git clone failed: ${result.stderr}`);
			}

			updated = true;
		} else {
			// Get current commit before updating
			const beforeResult = await execGit(['rev-parse', 'HEAD'], repoPath, env);
			const beforeCommit = beforeResult.stdout;

			// Fetch + hard-reset to the configured branch. Avoid `git pull`, which can
			// create merge commits or leave the worktree in a conflicted state when
			// the configured branch differs from the currently checked-out branch.
			// Both commands carry the same SIGKILL timeout as the clone so a hung
			// network fetch can never wedge syncStatus='syncing' (cleanupStaleSyncStates
			// only runs at scheduler start).
			assertSafeGitRef(repo.branch);
			const fetchResult = await execGit(['fetch', 'origin', repo.branch], repoPath, env, CENTRALIZED_CLONE_TIMEOUT_MS);
			if (fetchResult.code !== 0) {
				throw new Error(`Git fetch failed: ${fetchResult.stderr}`);
			}
			const checkoutResult = await execGit(
				['checkout', '-B', repo.branch, `origin/${repo.branch}`],
				repoPath,
				env,
				CENTRALIZED_CLONE_TIMEOUT_MS
			);
			if (checkoutResult.code !== 0) {
				throw new Error(`Git checkout failed: ${checkoutResult.stderr}`);
			}

			// Get commit after update
			const afterResult = await execGit(['rev-parse', 'HEAD'], repoPath, env);
			const afterCommit = afterResult.stdout;

			updated = beforeCommit !== afterCommit;
		}

		// Get current commit hash
		const commitResult = await execGit(['rev-parse', 'HEAD'], repoPath, env);
		currentCommit = commitResult.stdout.substring(0, 7);

		// Read the compose file (if present — may not exist if this is a browse-only clone)
		let composeContent: string | undefined;
		if (repo.composePath && existsSync(repoFilePath(repoPath, repo.composePath, 'Compose path'))) {
			const composePath = repoFilePath(repoPath, repo.composePath, 'Compose path');
			composeContent = readFileSync(composePath, 'utf-8');
		} else {
			console.warn(`[Git] Compose file not found at ${repo.composePath} — skipping content read (will be validated on deploy)`);
		}

		// Update repository status
		await updateGitRepository(repoId, {
			syncStatus: 'synced',
			lastSync: new Date().toISOString(),
			lastCommit: currentCommit,
			syncError: null
		});

		cleanupSshKey(credential, env);

		return {
			success: true,
			commit: currentCommit,
			composeContent,
			updated
		};
	} catch (error: any) {
		cleanupSshKey(credential, env);
		await updateGitRepository(repoId, {
			syncStatus: 'error',
			syncError: error.message
		});
		return { success: false, error: error.message };
	}
}

export async function checkForUpdates(repoId: number): Promise<{ hasUpdates: boolean; currentCommit?: string; latestCommit?: string; error?: string }> {
	const repo = await getGitRepository(repoId);
	if (!repo) {
		return { hasUpdates: false, error: 'Repository not found' };
	}

	const credential = repo.credentialId ? await getGitCredential(repo.credentialId) : null;
	const repoPath = getRepoPath(repo.name);
	const env = await buildGitEnv(credential);

	try {
		if (!existsSync(repoPath)) {
			return { hasUpdates: true, currentCommit: 'none', latestCommit: 'unknown' };
		}

		// Get current commit
		const currentResult = await execGit(['rev-parse', 'HEAD'], repoPath, env);
		const currentCommit = currentResult.stdout.substring(0, 7);

		// Fetch latest without merging. Guard the branch like every other
		// exec path — a stored branch starting with '-' would be parsed as a
		// git option. Same SIGKILL timeout as the clone (M7).
		assertSafeGitRef(repo.branch);
		await execGit(['fetch', 'origin', repo.branch], repoPath, env, CENTRALIZED_CLONE_TIMEOUT_MS);

		// Get remote commit
		const latestResult = await execGit(['rev-parse', `origin/${repo.branch}`], repoPath, env);
		const latestCommit = latestResult.stdout.substring(0, 7);

		cleanupSshKey(credential, env);

		return {
			hasUpdates: currentCommit !== latestCommit,
			currentCommit,
			latestCommit
		};
	} catch (error: any) {
		cleanupSshKey(credential, env);
		return { hasUpdates: false, error: error.message };
	}
}

// =============================================================================
// REPOSITORY-LEVEL FAN-OUT
// =============================================================================

/**
 * In-flight sync promises per repository ID.
 * When multiple git stacks share the same repository and are synced concurrently,
 * the second (and subsequent) callers wait for the first sync to complete and
 * receive its result — no duplicate clones are started.
 */
const repoSyncInFlight = new Map<number, Promise<SyncResult>>();

/**
 * Global cap on concurrent centralized repo syncs (each runs git clone/fetch
 * subprocesses, up to CENTRALIZED_CLONE_TIMEOUT_MS each). Per-repo dedup above
 * bounds duplicate work for one repo; this bounds N different repos fanning out
 * at once from scheduled/coalesced triggers.
 */
const repoSyncSemaphore = new Semaphore(REPO_SYNC_CONCURRENCY);

/**
 * Sync a repository with concurrency control.
 * If a sync is already in progress for this repository ID, the caller waits
 * for the existing sync to finish and receives its result (no duplicate clone).
 */
export async function syncRepositoryExclusive(repoId: number): Promise<SyncResult> {
	const existing = repoSyncInFlight.get(repoId);
	if (existing) {
		console.log(`[Git] Waiting for in-flight sync of repository ${repoId}...`);
		return existing;
	}
	const promise = repoSyncSemaphore.run(() => syncRepository(repoId)).finally(() => {
		repoSyncInFlight.delete(repoId);
	});
	repoSyncInFlight.set(repoId, promise);
	return promise;
}

type FanOutOpts = {
	log?: (msg: string) => void;
	/** When set, only these stack IDs are fanned out (env-scoped manual deploys). */
	stackIds?: number[];
};

/** Per-stack deploy coalesce slots (repo webhook fan-out ↔ stack webhook). */
const stackDeploySlots = new Map<number, CoalesceSlot<DeployGitStackOpts, DeployGitStackResult>>();

/**
 * Per-repository fan-out coalesce slots. Keyed by repo + authorization scope
 * (fanOutScopeKey), NOT repo alone: concurrent callers with different
 * env-scoped stack sets must never merge into one run — the union would deploy
 * stacks a caller was not authorized for (cross-boundary). Same-scope requests
 * (repeated repo webhooks, repeat manual deploys by one user) still coalesce.
 */
const repoFanOutSlots = new Map<string, CoalesceSlot<FanOutOpts, FanOutResult>>();

/** Coalesce key for a repo fan-out: repository + normalized authorized stack set. */
function fanOutScopeKey(repositoryId: number, stackIds: number[] | undefined): string {
	const scope = stackIds ? [...stackIds].sort((a, b) => a - b).join(',') : 'all';
	return `${repositoryId}:${scope}`;
}

/**
 * Number of coalesced git operations currently in flight (stack deploys +
 * repo fan-outs). Slots are removed from the maps on completion, so `.size`
 * is the live in-flight count. Used by the per-stack migration drain (git-stack-migrate.ts).
 */
export function getActiveGitCoalesceCount(): number {
	return stackDeploySlots.size + repoFanOutSlots.size;
}

/**
 * Per-id view of in-flight coalesced git operations: centralized stack deploys
 * (keyed by stack id) and repo fan-outs (keyed by repository id). Used by the
 * per-selected-stack migration drain so migrating stack 2 never waits on stack
 * 1's deploy.
 */
export function getActiveGitCoalesceIds(): { stacks: number[]; repos: number[] } {
	return {
		stacks: [...stackDeploySlots.keys()],
		repos: [...repoFanOutSlots.keys()].map((k) => Number(k.split(':')[0]))
	};
}

function mergeFanOutOpts(a: FanOutOpts, b: FanOutOpts): FanOutOpts {
	// Prefer the newer caller's logger so its schedule-execution log is populated.
	// Same-scope callers coalesce (identical stackIds), so the union below is
	// identity in practice — different scopes never share a slot (fanOutScopeKey).
	return { log: b.log ?? a.log, stackIds: mergeFanOutStackIds(a.stackIds, b.stackIds) };
}

/**
 * Re-entrancy marker: deployGitStack holds the coalesce slot and then calls
 * syncGitStack — that nested call must not wait on its own slot.
 */
const stackDeployReentrancy = new Set<number>();

/**
 * Wait until no coalesced stack deploy is in flight for this stack.
 * Used by standalone sync so it does not race a webhook deploy mid-flight.
 */
async function waitForStackDeployIdle(stackId: number): Promise<void> {
	for (;;) {
		const slot = stackDeploySlots.get(stackId);
		if (!slot || slot.done) return;
		console.log(`[Git] Stack ${stackId}: waiting for in-flight deploy to finish before sync...`);
		await slot.idle;
	}
}

export async function deployFromRepositoryWithFanOut(
	repositoryId: number,
	log?: (msg: string) => void,
	stackIds?: number[]
): Promise<FanOutResult> {
	// Coalesce concurrent repo webhooks / manual triggers for the same repository
	// AND authorization scope into a single in-flight fan-out (+ at most one
	// trailing re-run). Different env-scoped callers get separate runs — the
	// union of their stack IDs would cross authorization boundaries.
	return runCoalesced(
		repoFanOutSlots,
		fanOutScopeKey(repositoryId, stackIds),
		{ log, stackIds },
		mergeFanOutOpts,
		(opts) => deployFromRepositoryWithFanOutImpl(repositoryId, opts.log, opts.stackIds)
	);
}

async function deployFromRepositoryWithFanOutImpl(
	repositoryId: number,
	log?: (msg: string) => void,
	stackIds?: number[]
): Promise<FanOutResult> {
	const _log = log || console.log;

	const repo = await getGitRepository(repositoryId);
	if (!repo) {
		return { success: false, error: 'Repository not found' };
	}

	_log(`[Git] Starting fan-out deployment for repository "${repo.name}" (ID: ${repositoryId})`);

	// Get all stacks tied to this repository that run in centralized mode.
	// Stack-model siblings keep their own per-stack clone + webhook contract and
	// must NOT be deployed from the shared clone's fan-out (mixed repos).
	let stacks = filterCentralizedStacks(await getFullGitStacksByRepositoryId(repositoryId));
	if (stackIds) {
		const allowed = new Set(stackIds);
		stacks = stacks.filter((s) => allowed.has(s.id));
		_log(`[Git] Fan-out filtered to ${stacks.length} stack(s) authorized for this caller.`);
	}
	if (stacks.length === 0) {
		_log(`[Git] No centralized stacks linked to repository "${repo.name}".`);
		return { success: true, stacks: [] };
	}

	_log(`[Git] Found ${stacks.length} centralized stack(s) linked to this repository.`);

	// Concurrent stack-level webhooks coalesce inside deployGitStack (stronger
	// intent wins), and stacks with their own webhook are deferred there.
	return fanOutDeployStacks(stacks, (stackId, opts) => deployGitStack(stackId, opts), _log);
}

// =============================================================================
// STACK-LEVEL OPERATIONS
// =============================================================================

export async function syncGitStack(stackId: number, onProgress?: ProgressCallback): Promise<SyncResult> {
	// If a coalesced deploy owns this stack, wait for it rather than failing.
	// (deployGitStack calls syncGitStack while it already holds the slot — that
	// path is re-entrant via the flag below.)
	if (!stackDeployReentrancy.has(stackId)) {
		await waitForStackDeployIdle(stackId);
	}

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

	// Concurrent deploys are serialized via stackDeploySlots — a stale DB status here
	// should not produce a spurious error, but guard when not re-entrant.
	if (gitStack.syncStatus === 'syncing' && !stackDeployReentrancy.has(stackId)) {
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
	const env = await buildGitEnv(credential);

	console.log(`${logPrefix} Has credential:`, !!credential);

	try {
		// Step 1: Connecting
		onProgress?.({ status: 'connecting', message: 'Connecting to repository...', step: 1, totalSteps: 5 });
		// Update sync status
		await updateGitStack(stackId, { syncStatus: 'syncing', syncError: null });

		let updated = false;
		let currentCommit = '';

		// Sync the shared repository clone. If another stack is already syncing this
		// repository, wait for that sync to complete and share the result (no duplicate clone).
		console.log(`${logPrefix} Syncing shared repository clone...`);
		onProgress?.({ status: 'cloning', message: 'Syncing repository...', step: 2, totalSteps: 5 });
		const repoSyncResult = await syncRepositoryExclusive(gitStack.repositoryId);
		if (!repoSyncResult.success) {
			throw new Error(`Repository sync failed: ${repoSyncResult.error}`);
		}
		onProgress?.({ status: 'fetching', message: 'Repository up to date', step: 3, totalSteps: 5 });
		const repoPath = getRepoPath(repo.name);

		// Use the DB's last known commit as the baseline for change detection.
		// The shared clone is up to date after syncRepositoryExclusive completes.
		const previousCommit = gitStack.lastCommit ?? null;

		// Get current commit from the shared clone
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
		onProgress?.({ status: 'reading', message: `Reading ${gitStack.composePath}...`, step: 4, totalSteps: 5 });
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
			// Validate: context dir must be within repo (sep-aware; rejects sibling prefix matches)
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
					// Realpath containment: a git-tracked symlink pointing outside
					// the repo must not be followed (host file exfiltration).
					const realEnvPath = realpathSync(envFilePath);
					if (!isPathUnderRoot(realEnvPath, realpathSync(repoPath))) {
						console.warn(`${logPrefix} Configured env file resolves outside the repository — skipping: ${gitStack.envFilePath}`);
					} else {
						console.log(`${logPrefix} Reading env file...`);
						envFileContent = readFileSync(realEnvPath, 'utf-8');
						envFileVars = parseEnvFileContent(envFileContent, gitStack.stackName);
						console.log(`${logPrefix} Env file parsed, vars count:`, Object.keys(envFileVars).length);

						// Compute env file path relative to compose directory
						// This is needed for --env-file flag after files are copied to stack directory
						envFileName = relative(composeDir, envFilePath);
						console.log(`${logPrefix} Env filename relative to compose dir:`, envFileName);
					}
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

async function deployGitStackCore(
	stackId: number,
	opts: DeployGitStackOpts,
	onProgress?: ProgressCallback
): Promise<DeployGitStackResult> {
	const { force, ignoreForceRedeploy } = opts;

	const gitStack = await getGitStack(stackId);
	if (!gitStack) {
		onProgress?.({ status: 'error', error: 'Git stack not found' });
		return { success: false, error: 'Git stack not found' };
	}

	const logPrefix = `[Stack:${gitStack.stackName}]`;
	console.log(`${logPrefix} ========================================`);
	console.log(`${logPrefix} DEPLOY GIT STACK START`);
	console.log(`${logPrefix} ========================================`);
	console.log(`${logPrefix} Stack ID:`, stackId);
	console.log(`${logPrefix} Force deploy:`, force);
	console.log(`${logPrefix} Ignore force redeploy:`, ignoreForceRedeploy);

	// Mark re-entrancy so nested syncGitStack does not wait on our own slot
	stackDeployReentrancy.add(stackId);
	try {
		// Sync first
		console.log(`${logPrefix} Syncing git repository...`);
		const syncResult = await syncGitStack(stackId, onProgress);
		if (!syncResult.success) {
			console.log(`${logPrefix} Sync failed:`, syncResult.error);
			const failResult = { success: false, error: syncResult.error };
			await notifyGitSync(gitStack.stackName, gitStack.environmentId, failResult);
			onProgress?.({ status: 'error', error: syncResult.error });
			return failResult;
		}

		console.log(`${logPrefix} Sync successful`);
		console.log(`${logPrefix} Sync result - updated:`, syncResult.updated);
		console.log(`${logPrefix} Sync result - commit:`, syncResult.commit);
		console.log(`${logPrefix} Sync result - env file vars:`, syncResult.envFileVars ? Object.keys(syncResult.envFileVars).length : 0);
		if (syncResult.envFileVars && Object.keys(syncResult.envFileVars).length > 0) {
			console.log(`${logPrefix} Env file var keys:`, Object.keys(syncResult.envFileVars).join(', '));
			console.log(`${logPrefix} Env file vars (masked):`, JSON.stringify(redactEnvVarsForLog(syncResult.envFileVars), null, 2));
		}

		// Deploy using the shared post-sync body (git-deploy-shared.ts).
		return deployStackFromSync({ stackId, gitStack, opts: { force, ignoreForceRedeploy }, syncResult, onProgress, logPrefix });
	} finally {
		stackDeployReentrancy.delete(stackId);
	}
}

export async function deployGitStack(
	stackId: number,
	options?: { force?: boolean; ignoreForceRedeploy?: boolean }
): Promise<DeployGitStackResult> {
	// Coalesce concurrent stack deploys (stack webhook ↔ repo fan-out ↔ manual).
	// Stronger intent wins: force ORs; ignoreForceRedeploy only if all agree.
	const opts: DeployGitStackOpts = {
		force: options?.force ?? true, // Default to force for backward compatibility
		ignoreForceRedeploy: options?.ignoreForceRedeploy ?? false
	};

	return runCoalesced(
		stackDeploySlots,
		stackId,
		opts,
		mergeDeployGitStackOpts,
		(merged) => deployGitStackCore(stackId, merged)
	);
}

export async function deleteGitStackFiles(stackId: number, stackName?: string, environmentId?: number | null): Promise<void> {
	// No-op: git stacks no longer maintain per-stack clone directories.
	// The shared repository clone (DATA_DIR/git-repos/shared/<repoName>) is managed
	// by the repository lifecycle and is only removed when the repository is deleted.
}

export async function deployGitStackWithProgress(
	stackId: number,
	onProgress: ProgressCallback
): Promise<DeployGitStackResult> {
	// Serialize with webhook/cron deploys via the same coalesce slot (force deploy).
	// Progress UI waits cleanly instead of failing with "already in progress".
	return runCoalesced(
		stackDeploySlots,
		stackId,
		{ force: true, ignoreForceRedeploy: false } satisfies DeployGitStackOpts,
		mergeDeployGitStackOpts,
		(merged) => deployGitStackCore(stackId, merged, onProgress)
	);
}

// =============================================================================
// ENV FILE OPERATIONS (centralized: reads the shared clone)
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

	const repo = await getGitRepository(gitStack.repositoryId);
	if (!repo) {
		return { files: [], error: 'Repository not found' };
	}
	const repoPath = getRepoPath(repo.name);
	if (!existsSync(repoPath)) {
		return { files: [], error: 'Repository not synced — deploy the stack first to populate the shared clone' };
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
 */
export async function readGitStackEnvFile(
	stackId: number,
	envFilePath: string
): Promise<{ vars: Record<string, string>; error?: string }> {
	const gitStack = await getGitStack(stackId);
	if (!gitStack) {
		return { vars: {}, error: 'Git stack not found' };
	}

	const repo = await getGitRepository(gitStack.repositoryId);
	if (!repo) {
		return { vars: {}, error: 'Repository not found' };
	}
	const repoPath = getRepoPath(repo.name);
	if (!existsSync(repoPath)) {
		return { vars: {}, error: 'Repository not synced — deploy the stack first to populate the shared clone' };
	}

	// Security check: ensure the path doesn't escape the repo. Both lexical
	// containment (../ traversal) and realpath containment (a git-tracked
	// symlink pointing outside the repo) are checked, so a malicious repo
	// cannot exfiltrate host files through the env-file reader.
	const fullPath = resolve(repoPath, envFilePath);
	if (!isPathUnderRoot(fullPath, repoPath)) {
		return { vars: {}, error: 'Invalid file path' };
	}

	if (!existsSync(fullPath)) {
		return { vars: {}, error: `File not found: ${envFilePath}` };
	}

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

export const CentralizedGitEngine: GitEngine = {
	syncGitStack,
	deployGitStack,
	deployGitStackWithProgress,
	deleteGitStackFiles,
	listGitStackEnvFiles,
	readGitStackEnvFile,
	syncRepository,
	syncRepositoryExclusive,
	deployFromRepositoryWithFanOut,
	checkForUpdates
};

export type { GitMode };
