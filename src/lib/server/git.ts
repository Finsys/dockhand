import { existsSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join, resolve, dirname, basename, relative } from 'node:path';
import {
	getGitRepository,
	getGitCredential,
	updateGitRepository,
	getGitStack,
	updateGitStack,
	upsertStackSource,
	type GitRepository,
	type GitCredential,
	type GitStackWithRepo
} from './db';
import { deployStack, getStackDir } from './stacks';

// Directory for storing cloned repositories
const GIT_REPOS_DIR = process.env.GIT_REPOS_DIR || './data/git-repos';

// Ensure git repos directory exists
if (!existsSync(GIT_REPOS_DIR)) {
	mkdirSync(GIT_REPOS_DIR, { recursive: true });
}

/**
 * Mask sensitive values in environment variables for safe logging.
 */
function maskSecrets(vars: Record<string, string>): Record<string, string> {
	const masked: Record<string, string> = {};
	const secretPatterns = /password|secret|token|key|api_key|apikey|auth|credential|private/i;
	for (const [key, value] of Object.entries(vars)) {
		if (secretPatterns.test(key)) {
			masked[key] = '***';
		} else if (value.length > 50) {
			masked[key] = value.substring(0, 10) + '...(truncated)';
		} else {
			masked[key] = value;
		}
	}
	return masked;
}

function getRepoPath(repoId: number): string {
	return join(GIT_REPOS_DIR, `repo-${repoId}`);
}

interface GitEnv {
	[key: string]: string;
}

async function buildGitEnv(credential: GitCredential | null): Promise<GitEnv> {
	const env: GitEnv = {
		...process.env as GitEnv,
		GIT_TERMINAL_PROMPT: '0',
		// Prevent SSH agent from providing keys automatically
		SSH_AUTH_SOCK: ''
	};

	if (credential?.authType === 'ssh' && credential.sshPrivateKey) {
		// Create a temporary SSH key file (use absolute path so SSH can find it)
		const sshKeyPath = resolve(join(GIT_REPOS_DIR, `.ssh-key-${credential.id}`));

		// Ensure SSH key ends with a newline (newer SSH versions are strict about this)
		let keyContent = credential.sshPrivateKey;
		if (!keyContent.endsWith('\n')) {
			keyContent += '\n';
		}

		await Bun.write(sshKeyPath, keyContent);
		// Ensure SSH key has correct permissions (0600 = owner read/write only)
		// Bun.write's mode option doesn't always work reliably, so use chmodSync
		chmodSync(sshKeyPath, 0o600);

		// Configure SSH to use ONLY this key (no agent, no default keys)
		const sshCommand = `ssh -i "${sshKeyPath}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes`;
		env.GIT_SSH_COMMAND = sshCommand;
	} else {
		// No SSH credential - prevent using any keys (IdentitiesOnly=yes with no -i means no keys)
		env.GIT_SSH_COMMAND = 'ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes -o PasswordAuthentication=no -o PubkeyAuthentication=no';
	}

	return env;
}

function cleanupSshKey(credential: GitCredential | null): void {
	if (credential?.authType === 'ssh') {
		const sshKeyPath = resolve(join(GIT_REPOS_DIR, `.ssh-key-${credential.id}`));
		try {
			if (existsSync(sshKeyPath)) {
				rmSync(sshKeyPath);
			}
		} catch {
			// Ignore cleanup errors
		}
	}
}

function buildRepoUrl(url: string, credential: GitCredential | null): string {
	// For SSH URLs or no auth, return as-is
	if (!credential || credential.authType !== 'password' || url.startsWith('git@')) {
		return url;
	}

	// For HTTPS with password auth, embed credentials
	try {
		const parsed = new URL(url);
		if (credential.username) {
			parsed.username = credential.username;
		}
		if (credential.password) {
			parsed.password = credential.password;
		}
		return parsed.toString();
	} catch {
		return url;
	}
}

async function execGit(args: string[], cwd: string, env: GitEnv): Promise<{ stdout: string; stderr: string; code: number }> {
	try {
		const proc = Bun.spawn(['git', ...args], {
			cwd,
			env,
			stdout: 'pipe',
			stderr: 'pipe'
		});

		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text()
		]);

		const code = await proc.exited;

		return { stdout: stdout.trim(), stderr: stderr.trim(), code };
	} catch (err: any) {
		return { stdout: '', stderr: err.message, code: 1 };
	}
}

/**
 * Get list of files that changed between two commits in a specific directory.
 * Returns array of changed file paths (relative to repo root).
 */
async function getChangedFilesInDir(
	repoPath: string,
	previousCommit: string,
	newCommit: string,
	dirPath: string,
	env: GitEnv
): Promise<{ changed: boolean; files: string[]; error?: string }> {
	if (!previousCommit) {
		// No previous commit means this is a new clone - always deploy
		return { changed: true, files: ['(new clone - all files)'] };
	}

	// Use git diff --name-only to get all changed files in the directory
	// The trailing slash ensures we only match files IN that directory (and subdirs)
	const dirPattern = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
	const result = await execGit(
		['diff', '--name-only', previousCommit, newCommit, '--', dirPattern],
		repoPath,
		env
	);

	// If the command fails (e.g., previousCommit no longer exists after force push),
	// assume files changed to be safe
	if (result.code !== 0) {
		return { changed: true, files: ['(diff failed - assuming changed)'], error: result.stderr };
	}

	// Parse changed files
	const changedFiles = result.stdout.trim()
		.split('\n')
		.filter(f => f.length > 0);

	return { changed: changedFiles.length > 0, files: changedFiles };
}

export interface SyncResult {
	success: boolean;
	commit?: string;
	composeContent?: string;
	composeDir?: string; // Directory containing the compose file (for copying all files)
	composeFileName?: string; // Filename of the compose file (e.g., "docker-compose.yaml")
	envFileVars?: Record<string, string>; // Variables from .env file in repo
	envFileContent?: string; // Raw .env file content (for Hawser deployments)
	envFileName?: string; // Filename of env file relative to composeDir (e.g., ".env" or "../.env")
	error?: string;
	updated?: boolean;
	changedFiles?: string[]; // List of files that changed (for logging/debugging)
}

export interface TestResult {
	success: boolean;
	branch?: string;
	lastCommit?: string;
	composeFileExists?: boolean;
	error?: string;
}

/**
 * Clean up git/SSH error messages for user display
 */
function cleanGitError(stderr: string): string {
	// Remove SSH warnings and noise
	const lines = stderr.split('\n').filter(line => {
		const l = line.trim().toLowerCase();
		// Skip SSH warnings
		if (l.startsWith('warning:')) return false;
		if (l.includes('added') && l.includes('to the list of known hosts')) return false;
		// Skip empty lines
		if (!l) return false;
		return true;
	});

	// Find the most relevant error
	const fatalLine = lines.find(l => l.toLowerCase().includes('fatal:'));
	const permissionLine = lines.find(l => l.toLowerCase().includes('permission denied'));
	const errorLine = lines.find(l => l.toLowerCase().includes('error:'));

	// Return cleaner message
	if (permissionLine) {
		return 'Permission denied. Check your SSH credentials.';
	}
	if (fatalLine) {
		// Clean up common fatal messages
		const msg = fatalLine.replace(/^fatal:\s*/i, '').trim();
		if (msg.includes('Could not read from remote repository')) {
			return 'Could not access repository. Check URL and credentials.';
		}
		return msg;
	}
	if (errorLine) {
		return errorLine.replace(/^error:\s*/i, '').trim();
	}

	// Fallback to original (joined and trimmed)
	return lines.join(' ').trim() || 'Failed to connect to repository';
}

/**
 * Core function to test a git repository connection.
 * Tests the URL, branch, and credentials passed directly (not from DB).
 */
async function testRepositoryConnection(options: {
	url: string;
	branch: string;
	credential: GitCredential | null;
}): Promise<TestResult> {
	const { url, branch, credential } = options;

	const env = await buildGitEnv(credential);
	const repoUrl = buildRepoUrl(url, credential);

	try {
		// Use git ls-remote to test connection and verify branch
		const result = await execGit(
			['ls-remote', '--heads', '--refs', repoUrl, branch || 'HEAD'],
			process.cwd(),
			env
		);

		cleanupSshKey(credential);

		if (result.code !== 0) {
			console.error('[Git] Connection test failed:', result.stderr);
			return { success: false, error: cleanGitError(result.stderr) };
		}

		// Parse the output to get commit hash
		const lines = result.stdout.split('\n').filter(l => l.trim());
		if (lines.length === 0) {
			// Branch not found, but connection worked - check if repo has any branches
			const allBranchesResult = await execGit(
				['ls-remote', '--heads', '--refs', repoUrl],
				process.cwd(),
				env
			);
			cleanupSshKey(credential);

			if (allBranchesResult.code !== 0) {
				return { success: false, error: cleanGitError(allBranchesResult.stderr) };
			}

			const allBranches = allBranchesResult.stdout.split('\n')
				.filter(l => l.trim())
				.map(l => {
					const m = l.match(/refs\/heads\/(.+)$/);
					return m ? m[1] : null;
				})
				.filter(Boolean);

			if (allBranches.length === 0) {
				return { success: true, branch: '(empty repository)' };
			}

			return {
				success: false,
				error: `Branch '${branch}' not found. Available branches: ${allBranches.slice(0, 5).join(', ')}${allBranches.length > 5 ? '...' : ''}`
			};
		}

		const match = lines[0].match(/^([a-f0-9]+)\s+refs\/heads\/(.+)$/);
		const lastCommit = match ? match[1].substring(0, 7) : undefined;
		const foundBranch = match ? match[2] : branch;

		return {
			success: true,
			branch: foundBranch,
			lastCommit
		};
	} catch (error: any) {
		cleanupSshKey(credential);
		return { success: false, error: error.message };
	}
}

/**
 * Test a saved repository from the database (used by grid test button).
 */
export async function testRepository(repoId: number): Promise<TestResult> {
	const repo = await getGitRepository(repoId);
	if (!repo) {
		return { success: false, error: 'Repository not found' };
	}

	const credential = repo.credentialId ? await getGitCredential(repo.credentialId) : null;

	return testRepositoryConnection({
		url: repo.url,
		branch: repo.branch,
		credential
	});
}

/**
 * Test a repository configuration before saving (used by modal test button).
 * Uses credentialId to fetch stored credentials from the database.
 */
export async function testRepositoryConfig(options: {
	url: string;
	branch: string;
	credentialId?: number | null;
}): Promise<TestResult> {
	const { url, branch, credentialId } = options;

	if (!url) {
		return { success: false, error: 'Repository URL is required' };
	}

	// Fetch credential from database if credentialId is provided
	const credential = credentialId ? await getGitCredential(credentialId) : null;
	if (credentialId && !credential) {
		return { success: false, error: 'Credential not found' };
	}

	return testRepositoryConnection({
		url,
		branch: branch || 'main',
		credential
	});
}

export async function syncRepository(repoId: number): Promise<SyncResult> {
	const repo = await getGitRepository(repoId);
	if (!repo) {
		return { success: false, error: 'Repository not found' };
	}

	// Check if sync is already in progress
	if (repo.syncStatus === 'syncing') {
		return { success: false, error: 'Sync already in progress' };
	}

	const credential = repo.credentialId ? await getGitCredential(repo.credentialId) : null;
	const repoPath = getRepoPath(repoId);
	const env = await buildGitEnv(credential);

	try {
		// Update sync status
		await updateGitRepository(repoId, { syncStatus: 'syncing', syncError: null });

		let updated = false;
		let currentCommit = '';

		if (!existsSync(repoPath)) {
			// Clone the repository (shallow clone)
			const repoUrl = buildRepoUrl(repo.url, credential);

			const result = await execGit(
				['clone', '--depth=1', '--branch', repo.branch, repoUrl, repoPath],
				process.cwd(),
				env
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
			// Get current commit before pull
			const beforeResult = await execGit(['rev-parse', 'HEAD'], repoPath, env);
			const beforeCommit = beforeResult.stdout;

			// Pull latest changes
			const result = await execGit(['pull', 'origin', repo.branch], repoPath, env);
			if (result.code !== 0) {
				throw new Error(`Git pull failed: ${result.stderr}`);
			}

			// Get commit after pull
			const afterResult = await execGit(['rev-parse', 'HEAD'], repoPath, env);
			const afterCommit = afterResult.stdout;

			updated = beforeCommit !== afterCommit;
		}

		// Get current commit hash
		const commitResult = await execGit(['rev-parse', 'HEAD'], repoPath, env);
		currentCommit = commitResult.stdout.substring(0, 7);

		// Read the compose file
		const composePath = join(repoPath, repo.composePath);
		if (!existsSync(composePath)) {
			throw new Error(`Compose file not found: ${repo.composePath}`);
		}

		const composeContent = await Bun.file(composePath).text();

		// Update repository status
		await updateGitRepository(repoId, {
			syncStatus: 'synced',
			lastSync: new Date().toISOString(),
			lastCommit: currentCommit,
			syncError: null
		});

		cleanupSshKey(credential);

		return {
			success: true,
			commit: currentCommit,
			composeContent,
			updated
		};
	} catch (error: any) {
		cleanupSshKey(credential);
		await updateGitRepository(repoId, {
			syncStatus: 'error',
			syncError: error.message
		});
		return { success: false, error: error.message };
	}
}

export async function deployFromRepository(repoId: number): Promise<{ success: boolean; output?: string; error?: string }> {
	const repo = await getGitRepository(repoId);
	if (!repo) {
		return { success: false, error: 'Repository not found' };
	}

	// Sync first
	const syncResult = await syncRepository(repoId);
	if (!syncResult.success) {
		return { success: false, error: syncResult.error };
	}

	const stackName = repo.name;

	// Deploy using unified function - handles both new and existing stacks
	const result = await deployStack({
		name: stackName,
		compose: syncResult.composeContent!,
		envId: repo.environmentId
	});

	if (result.success) {
		// Record the stack source
		await upsertStackSource({
			stackName: stackName,
			environmentId: repo.environmentId,
			sourceType: 'git',
			gitRepositoryId: repoId
		});
	}

	return result;
}

export async function checkForUpdates(repoId: number): Promise<{ hasUpdates: boolean; currentCommit?: string; latestCommit?: string; error?: string }> {
	const repo = await getGitRepository(repoId);
	if (!repo) {
		return { hasUpdates: false, error: 'Repository not found' };
	}

	const credential = repo.credentialId ? await getGitCredential(repo.credentialId) : null;
	const repoPath = getRepoPath(repoId);
	const env = await buildGitEnv(credential);

	try {
		if (!existsSync(repoPath)) {
			return { hasUpdates: true, currentCommit: 'none', latestCommit: 'unknown' };
		}

		// Get current commit
		const currentResult = await execGit(['rev-parse', 'HEAD'], repoPath, env);
		const currentCommit = currentResult.stdout.substring(0, 7);

		// Fetch latest without merging
		await execGit(['fetch', 'origin', repo.branch], repoPath, env);

		// Get remote commit
		const latestResult = await execGit(['rev-parse', `origin/${repo.branch}`], repoPath, env);
		const latestCommit = latestResult.stdout.substring(0, 7);

		cleanupSshKey(credential);

		return {
			hasUpdates: currentCommit !== latestCommit,
			currentCommit,
			latestCommit
		};
	} catch (error: any) {
		cleanupSshKey(credential);
		return { hasUpdates: false, error: error.message };
	}
}

export function deleteRepositoryFiles(repoId: number): void {
	const repoPath = getRepoPath(repoId);
	try {
		if (existsSync(repoPath)) {
			rmSync(repoPath, { recursive: true, force: true });
		}
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error('[Git] Failed to delete repository files:', errorMsg);
	}
}

// === Git Stack Functions ===

function getStackRepoPath(stackId: number): string {
	return join(GIT_REPOS_DIR, `stack-${stackId}`);
}

/**
 * Get the current commit hash from a repo path (if it exists).
 * Used to detect if repo was updated after re-clone.
 */
async function getPreviousCommit(repoPath: string, env: GitEnv): Promise<string | null> {
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

export async function syncGitStack(stackId: number): Promise<SyncResult> {
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
	const repoPath = getStackRepoPath(stackId);
	const env = await buildGitEnv(credential);

	console.log(`${logPrefix} Local repo path:`, repoPath);
	console.log(`${logPrefix} Has credential:`, !!credential);

	try {
		// Update sync status
		await updateGitStack(stackId, { syncStatus: 'syncing', syncError: null });

		let updated = false;
		let currentCommit = '';

		// Always re-clone to ensure clean state (handles branch/URL/credential changes, force pushes, etc.)
		// Shallow clones are fast so this is acceptable
		const previousCommit = await getPreviousCommit(repoPath, env);
		if (existsSync(repoPath)) {
			console.log(`${logPrefix} Removing existing clone for fresh sync...`);
			rmSync(repoPath, { recursive: true, force: true });
		}

		console.log(`${logPrefix} Cloning repository...`);
		const repoUrl = buildRepoUrl(repo.url, credential);

		const result = await execGit(
			['clone', '--depth=1', '--branch', repo.branch, repoUrl, repoPath],
			process.cwd(),
			env
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
		const commitChanged = previousCommit !== newCommit;
		console.log(`${logPrefix} Previous commit: ${previousCommit || '(none)'}, new commit: ${newCommit.substring(0, 7)}, commit changed: ${commitChanged}`);

		// Check if any files in the compose file's directory have changed
		// This catches changes to the compose file, env files, and any other referenced files
		// (e.g., config files, scripts, additional env files)
		let changedFiles: string[] = [];
		if (commitChanged) {
			// Get the directory containing the compose file (relative to repo root)
			const composeDirRelative = dirname(gitStack.composePath);
			console.log(`${logPrefix} Checking for changes in directory: ${composeDirRelative || '(root)'}`);

			const diffResult = await getChangedFilesInDir(
				repoPath,
				previousCommit,
				newCommit,
				composeDirRelative || '.',
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
		const composePath = join(repoPath, gitStack.composePath);
		console.log(`${logPrefix} Reading compose file from:`, composePath);
		if (!existsSync(composePath)) {
			console.log(`${logPrefix} ERROR: Compose file not found at:`, composePath);
			throw new Error(`Compose file not found: ${gitStack.composePath}`);
		}

		const composeContent = await Bun.file(composePath).text();
		console.log(`${logPrefix} Compose content length:`, composeContent.length, 'chars');
		console.log(`${logPrefix} Compose content:`);
		console.log(composeContent);

		// Determine the compose directory and filename (for copying all files)
		const composeDir = dirname(composePath);
		const composeFileName = basename(gitStack.composePath); // e.g., "docker-compose.yaml"
		console.log(`${logPrefix} Compose directory:`, composeDir);
		console.log(`${logPrefix} Compose filename:`, composeFileName);

		// Read env file if configured (optional - don't fail if missing)
		let envFileVars: Record<string, string> | undefined;
		let envFileContent: string | undefined;
		let envFileName: string | undefined;
		if (gitStack.envFilePath) {
			const envFilePath = join(repoPath, gitStack.envFilePath);
			console.log(`${logPrefix} Looking for env file at:`, envFilePath);
			if (existsSync(envFilePath)) {
				try {
					console.log(`${logPrefix} Reading env file...`);
					envFileContent = await Bun.file(envFilePath).text();
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

		// Update git stack status
		await updateGitStack(stackId, {
			syncStatus: 'synced',
			lastSync: new Date().toISOString(),
			lastCommit: currentCommit,
			syncError: null
		});

		cleanupSshKey(credential);

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
			changedFiles
		};
	} catch (error: any) {
		cleanupSshKey(credential);
		await updateGitStack(stackId, {
			syncStatus: 'error',
			syncError: error.message
		});
		console.log(`${logPrefix} SYNC ERROR:`, error.message);
		return { success: false, error: error.message };
	}
}

export async function deployGitStack(stackId: number, options?: { force?: boolean }): Promise<{ success: boolean; output?: string; error?: string; skipped?: boolean }> {
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
		return { success: false, error: syncResult.error };
	}

	console.log(`${logPrefix} Sync successful`);
	console.log(`${logPrefix} Sync result - updated:`, syncResult.updated);
	console.log(`${logPrefix} Sync result - commit:`, syncResult.commit);
	console.log(`${logPrefix} Sync result - env file vars:`, syncResult.envFileVars ? Object.keys(syncResult.envFileVars).length : 0);
	if (syncResult.envFileVars && Object.keys(syncResult.envFileVars).length > 0) {
		console.log(`${logPrefix} Env file var keys:`, Object.keys(syncResult.envFileVars).join(', '));
		console.log(`${logPrefix} Env file vars (masked):`, JSON.stringify(maskSecrets(syncResult.envFileVars), null, 2));
	}

	// Check if there are changes - skip redeploy if no changes and not forced
	// Note: For new stacks (first deploy), syncResult.updated will be true
	if (!force && !syncResult.updated) {
		console.log(`${logPrefix} No changes detected and force=false, skipping redeploy`);
		return {
			success: true,
			output: 'No changes detected, skipping redeploy',
			skipped: true
		};
	}

	const forceRecreate = syncResult.updated && !!gitStack.envFilePath;
	console.log(`${logPrefix} Will force recreate:`, forceRecreate, `(updated=${syncResult.updated}, hasEnvFile=${!!gitStack.envFilePath})`);

	// Deploy using unified function - handles both new and existing stacks
	// Uses `docker compose up -d --remove-orphans` which only recreates changed services
	// Force recreate when git detected changes AND stack has .env file configured
	// This ensures containers pick up new env var values even if compose file didn't change
	// Note: Without this, docker compose only detects compose file changes, not env var changes
	console.log(`${logPrefix} Calling deployStack...`);
	console.log(`${logPrefix} Source directory (composeDir):`, syncResult.composeDir);
	console.log(`${logPrefix} Compose filename:`, syncResult.composeFileName);
	console.log(`${logPrefix} Env filename:`, syncResult.envFileName ?? '(none)');

	const result = await deployStack({
		name: gitStack.stackName,
		compose: syncResult.composeContent!,
		envId: gitStack.environmentId,
		envFileVars: syncResult.envFileVars,
		sourceDir: syncResult.composeDir, // Copy entire directory from git repo
		composeFileName: syncResult.composeFileName, // Use original compose filename from repo
		envFileName: syncResult.envFileName, // Env file relative to compose dir (for --env-file flag, optional)
		forceRecreate
	});

	console.log(`${logPrefix} ----------------------------------------`);
	console.log(`${logPrefix} DEPLOY GIT STACK RESULT`);
	console.log(`${logPrefix} ----------------------------------------`);
	console.log(`${logPrefix} Success:`, result.success);
	if (result.output) console.log(`${logPrefix} Output:`, result.output);
	if (result.error) console.log(`${logPrefix} Error:`, result.error);

	if (result.success) {
		// Record the stack source with resolved compose path for consistency
		const stackDir = await getStackDir(gitStack.stackName, gitStack.environmentId);
		const resolvedComposePath = syncResult.composeFileName
			? join(stackDir, syncResult.composeFileName)
			: undefined;

		console.log(`${logPrefix} Resolved compose path for stack_sources:`, resolvedComposePath);

		await upsertStackSource({
			stackName: gitStack.stackName,
			environmentId: gitStack.environmentId,
			sourceType: 'git',
			gitRepositoryId: gitStack.repositoryId,
			gitStackId: stackId,
			composePath: resolvedComposePath
		});
	}

	return result;
}

export async function testGitStack(stackId: number): Promise<TestResult> {
	const gitStack = await getGitStack(stackId);
	if (!gitStack) {
		return { success: false, error: 'Git stack not found' };
	}

	const repo = await getGitRepository(gitStack.repositoryId);
	if (!repo) {
		return { success: false, error: 'Repository not found' };
	}

	const credential = repo.credentialId ? await getGitCredential(repo.credentialId) : null;
	const env = await buildGitEnv(credential);
	const repoUrl = buildRepoUrl(repo.url, credential);

	try {
		// Use git ls-remote to test connection and get branch info
		const result = await execGit(
			['ls-remote', '--heads', '--refs', repoUrl, repo.branch],
			process.cwd(),
			env
		);

		cleanupSshKey(credential);

		if (result.code !== 0) {
			return { success: false, error: result.stderr || 'Failed to connect to repository' };
		}

		// Parse the output to get commit hash
		const lines = result.stdout.split('\n').filter(l => l.trim());
		if (lines.length === 0) {
			return { success: false, error: `Branch '${repo.branch}' not found in repository` };
		}

		const match = lines[0].match(/^([a-f0-9]+)\s+refs\/heads\/(.+)$/);
		const lastCommit = match ? match[1].substring(0, 7) : undefined;
		const branch = match ? match[2] : repo.branch;

		cleanupSshKey(credential);

		return {
			success: true,
			branch,
			lastCommit
		};
	} catch (error: any) {
		cleanupSshKey(credential);
		return { success: false, error: error.message };
	}
}

export function deleteGitStackFiles(stackId: number): void {
	const repoPath = getStackRepoPath(stackId);
	try {
		if (existsSync(repoPath)) {
			rmSync(repoPath, { recursive: true, force: true });
		}
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error('[Git] Failed to delete git stack files:', errorMsg);
	}
}

// Progress callback type
type ProgressCallback = (data: {
	status: 'connecting' | 'cloning' | 'fetching' | 'reading' | 'deploying' | 'complete' | 'error';
	message?: string;
	step?: number;
	totalSteps?: number;
	error?: string;
}) => void;

export async function deployGitStackWithProgress(
	stackId: number,
	onProgress: ProgressCallback
): Promise<{ success: boolean; output?: string; error?: string }> {
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
	const repoPath = getStackRepoPath(stackId);
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
		const previousCommit = await getPreviousCommit(repoPath, env);

		// Step 2: Cloning
		onProgress({ status: 'cloning', message: 'Cloning repository...', step: 2, totalSteps });

		if (existsSync(repoPath)) {
			rmSync(repoPath, { recursive: true, force: true });
		}

		const repoUrl = buildRepoUrl(repo.url, credential);

		// Step 3: Fetching
		onProgress({ status: 'fetching', message: `Fetching branch ${repo.branch}...`, step: 3, totalSteps });
		const cloneResult = await execGit(
			['clone', '--depth=1', '--branch', repo.branch, repoUrl, repoPath],
			process.cwd(),
			env
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
		const commitChanged = previousCommit !== newCommit;

		// Check if any files in the compose file's directory have changed
		// (for consistency with syncGitStack, though this function always deploys)
		if (commitChanged) {
			const composeDir = dirname(gitStack.composePath);
			const diffResult = await getChangedFilesInDir(
				repoPath,
				previousCommit,
				newCommit,
				composeDir || '.',
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
		const composePath = join(repoPath, gitStack.composePath);
		if (!existsSync(composePath)) {
			throw new Error(`Compose file not found: ${gitStack.composePath}`);
		}

		const composeContent = await Bun.file(composePath).text();

		// Determine the compose directory (for copying all files)
		const composeDir = dirname(composePath);

		// Read env file if configured (optional - don't fail if missing)
		let envFileVars: Record<string, string> | undefined;
		if (gitStack.envFilePath) {
			const envFilePath = join(repoPath, gitStack.envFilePath);
			if (existsSync(envFilePath)) {
				try {
					const envContent = await Bun.file(envFilePath).text();
					envFileVars = parseEnvFileContent(envContent, gitStack.stackName);
				} catch (err) {
					// Log but don't fail - env file is optional
					console.warn(`Failed to read env file ${gitStack.envFilePath}:`, err);
				}
			} else {
				console.warn(`Configured env file not found: ${gitStack.envFilePath}`);
			}
		}

		// Update git stack status
		await updateGitStack(stackId, {
			syncStatus: 'synced',
			lastSync: new Date().toISOString(),
			lastCommit: currentCommit,
			syncError: null
		});

		cleanupSshKey(credential);

		// Step 5: Deploying stack
		// Uses `docker compose up -d --remove-orphans` which only recreates changed services
		onProgress({ status: 'deploying', message: `Deploying ${gitStack.stackName}...`, step: 5, totalSteps });
		const result = await deployStack({
			name: gitStack.stackName,
			compose: composeContent,
			envId: gitStack.environmentId,
			envFileVars,
			sourceDir: composeDir // Copy entire directory from git repo
		});

		if (result.success) {
			// Record the stack source
			await upsertStackSource({
				stackName: gitStack.stackName,
				environmentId: gitStack.environmentId,
				sourceType: 'git',
				gitRepositoryId: gitStack.repositoryId,
				gitStackId: stackId
			});

			onProgress({ status: 'complete', message: `Successfully deployed ${gitStack.stackName}` });
		} else {
			throw new Error(result.error || 'Failed to deploy stack');
		}

		return result;
	} catch (error: any) {
		cleanupSshKey(credential);
		await updateGitStack(stackId, {
			syncStatus: 'error',
			syncError: error.message
		});
		onProgress({ status: 'error', error: error.message });
		return { success: false, error: error.message };
	}
}

// =============================================================================
// ENV FILE OPERATIONS
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

	const repoPath = getStackRepoPath(stackId);
	if (!existsSync(repoPath)) {
		return { files: [], error: 'Repository not synced - deploy the stack first' };
	}

	try {
		// Find all .env* files recursively (but not too deep)
		const maxDepth = 3;

		// Use find to locate all .env* files
		const proc = Bun.spawn(['find', repoPath, '-maxdepth', String(maxDepth), '-type', 'f', '-name', '.env*'], {
			stdout: 'pipe',
			stderr: 'pipe'
		});
		const output = await new Response(proc.stdout).text();
		await proc.exited;

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
 * Parse a .env file content into key-value pairs.
 * Handles comments, empty lines, and quoted values.
 */
export function parseEnvFileContent(content: string, stackName?: string): Record<string, string> {
	const logPrefix = stackName ? `[Stack:${stackName}]` : '[Git]';
	const result: Record<string, string> = {};
	const skippedLines: string[] = [];
	const invalidKeys: string[] = [];

	console.log(`${logPrefix} ----------------------------------------`);
	console.log(`${logPrefix} PARSE ENV FILE CONTENT`);
	console.log(`${logPrefix} ----------------------------------------`);
	console.log(`${logPrefix} Raw content length:`, content.length, 'chars');
	console.log(`${logPrefix} Raw content:`);
	console.log(content);

	const lines = content.split('\n');
	console.log(`${logPrefix} Total lines:`, lines.length);

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		// Skip empty lines and comments
		if (!trimmed || trimmed.startsWith('#')) {
			if (trimmed) skippedLines.push(`Line ${i + 1}: ${trimmed.substring(0, 50)}...`);
			continue;
		}

		// Find the first = sign
		const eqIndex = trimmed.indexOf('=');
		if (eqIndex === -1) {
			skippedLines.push(`Line ${i + 1} (no =): ${trimmed.substring(0, 50)}`);
			continue;
		}

		const key = trimmed.substring(0, eqIndex).trim();
		let value = trimmed.substring(eqIndex + 1).trim();

		// Handle quoted values
		if ((value.startsWith('"') && value.endsWith('"')) ||
		    (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}

		// Only add if key is valid env var name
		if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			result[key] = value;
		} else {
			invalidKeys.push(`Line ${i + 1}: "${key}" (invalid key format)`);
		}
	}

	console.log(`${logPrefix} Parsed env vars count:`, Object.keys(result).length);
	console.log(`${logPrefix} Parsed env var keys:`, Object.keys(result).join(', '));
	console.log(`${logPrefix} Parsed env vars (masked):`, JSON.stringify(maskSecrets(result), null, 2));
	if (skippedLines.length > 0) {
		console.log(`${logPrefix} Skipped lines (${skippedLines.length}):`, skippedLines.slice(0, 10).join('; '));
	}
	if (invalidKeys.length > 0) {
		console.log(`${logPrefix} Invalid keys (${invalidKeys.length}):`, invalidKeys.join('; '));
	}

	return result;
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

	const repoPath = getStackRepoPath(stackId);
	if (!existsSync(repoPath)) {
		return { vars: {}, error: 'Repository not synced - deploy the stack first' };
	}

	// Security check: ensure the path doesn't escape the repo
	const normalizedPath = envFilePath.replace(/\.\./g, '').replace(/^\//, '');
	const fullPath = join(repoPath, normalizedPath);

	if (!fullPath.startsWith(repoPath)) {
		return { vars: {}, error: 'Invalid file path' };
	}

	if (!existsSync(fullPath)) {
		return { vars: {}, error: `File not found: ${envFilePath}` };
	}

	try {
		const content = await Bun.file(fullPath).text();
		const vars = parseEnvFileContent(content);
		return { vars };
	} catch (error: any) {
		return { vars: {}, error: error.message };
	}
}
