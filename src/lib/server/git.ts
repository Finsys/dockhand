/**
 * Git — shared infrastructure + mode-dispatching facade.
 *
 * This module owns:
 *  - low-level git/credential/CA plumbing (buildGitEnv, execGit, ...)
 *  - pure helpers shared by both engines (change detection, deletion-sync)
 *  - mode-agnostic operations (test, preview, env-file parsing)
 *  - the mode-dispatching facade: every stack/repository operation delegates to
 *    either StackGitEngine (git-stack.ts) or CentralizedGitEngine
 *    (git-centralized.ts) based on the effective git repository mode.
 *
 * Engines are SEALED: they import shared plumbing from here but never share
 * mutable path/sync helpers with each other (see F5). Centralized clones live
 * under git-repos/shared/<name>/ so no layout can collide with per-stack
 * clones (git-repos/<env>/<stack>, git-repos/stack-<id>).
 */

import { existsSync, mkdirSync, rmSync, chmodSync, readFileSync, writeFileSync, renameSync, readdirSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { GIT_SSH_KEY_PATH_ENV, makeSshKeyPath, removeSshKey } from './git-ssh-key';
import {
	getGitRepository,
	getGitRepositories,
	getGitCredential,
	getGitStack,
	getEnvironments,
	type GitRepository,
	type GitCredentialData
} from './db';
import { deployStack, getStackDir } from './stacks';
import { sendEventNotification } from './notifications';
import { buildBasicAuthHeader } from './git-auth';
import { assertSafeRepoUrl, assertSafeGitRef, repoFilePath } from './git-url-safety';
import { isPathUnderRoot } from './path-utils';
import { parseComposePathsColumn } from './compose-files';
import { collectProcess } from './process-utils';
import { redactEnvVarsForLog } from './log-utils';
import {
	mergeDeployGitStackOpts,
	shouldDeployGitStack,
	type DeployGitStackOpts
} from '../utils/git-deploy-gating';
import {
	parseManifest,
	serializeManifest,
	hashDirFiles,
	computeDeletions,
	buildNextManifest,
	buildSyncChangeSummary,
	formatChangeTable,
	skipReasonMessage,
	deletionSafetyCheck,
	type DeletionPlan,
	type DeletionApplyResult,
	type DeletionSkip,
	type SyncManifest
} from './git-deletions';
import { getGitMode, type GitMode } from './git-mode';

const MERGED_CA_BUNDLE_PATH = '/tmp/dockhand-merged-ca-bundle.crt';
let mergedCaBundleReady = false;

/**
 * Create a merged CA bundle combining system CAs with the custom cert from
 * NODE_EXTRA_CA_CERTS. GIT_SSL_CAINFO replaces the default CA store, so without
 * merging, public CAs (GitHub, GitLab) break.
 */
function getMergedCaBundlePath(): string {
	if (mergedCaBundleReady && existsSync(MERGED_CA_BUNDLE_PATH)) {
		console.log(`[Git] Using cached merged CA bundle: ${MERGED_CA_BUNDLE_PATH}`);
		return MERGED_CA_BUNDLE_PATH;
	}

	const customCertPath = process.env.NODE_EXTRA_CA_CERTS!;
	console.log(`[Git] NODE_EXTRA_CA_CERTS set to: ${customCertPath}`);

	const systemCaPaths = [
		process.env.SSL_CERT_FILE,
		'/etc/ssl/certs/ca-certificates.crt',
		'/etc/pki/tls/certs/ca-bundle.crt',
		'/etc/ssl/cert.pem'
	];

	let systemCaContent = '';
	let systemCaSource = '';
	for (const caPath of systemCaPaths) {
		if (caPath && existsSync(caPath)) {
			try {
				systemCaContent = readFileSync(caPath, 'utf-8');
				systemCaSource = caPath;
				console.log(`[Git] Found system CA bundle: ${caPath} (${systemCaContent.split('-----BEGIN CERTIFICATE-----').length - 1} certs)`);
				break;
			} catch (err) {
				console.log(`[Git] Failed to read system CA bundle ${caPath}: ${err}`);
			}
		}
	}

	if (!systemCaSource) {
		console.log(`[Git] No system CA bundle found, using custom cert only: ${customCertPath}`);
	}

	try {
		const customCaContent = readFileSync(customCertPath, 'utf-8');
		const customCertCount = customCaContent.split('-----BEGIN CERTIFICATE-----').length - 1;
		console.log(`[Git] Custom CA file contains ${customCertCount} cert(s)`);

		const merged = systemCaContent
			? systemCaContent.trimEnd() + '\n' + customCaContent.trimEnd() + '\n'
			: customCaContent;
		writeFileSync(MERGED_CA_BUNDLE_PATH, merged);
		mergedCaBundleReady = true;

		const totalCerts = merged.split('-----BEGIN CERTIFICATE-----').length - 1;
		console.log(`[Git] Created merged CA bundle: ${MERGED_CA_BUNDLE_PATH} (${totalCerts} total certs — system from ${systemCaSource || 'none'} + custom from ${customCertPath})`);
	} catch (err) {
		console.warn(`[Git] Failed to create merged CA bundle, falling back to custom cert only: ${customCertPath}`, err);
		return customCertPath;
	}

	return MERGED_CA_BUNDLE_PATH;
}

// Git clone path layout (centralized shared/ namespace + per-stack paths)
// lives in git-paths.ts — a DB-free module so the isolation rules can be
// unit-tested. Re-exported here for callers.
import {
	getGitReposDir,
	getRepoPath,
	sanitizeRepoName,
	GIT_REPOS_DIR,
	stackRepoPath
} from './git-paths';
export { getGitReposDir, getRepoPath, sanitizeRepoName, stackRepoPath, GIT_REPOS_DIR };

/**
 * True when `candidateName` would share a clone directory with another repository
 * after sanitization (e.g. "a b" vs "a  b" both become "a_b"), or with a
 * per-environment clone directory (git-repos/<envName>/). Refusing the collision
 * protects both layouts during and after a mode transition (F2).
 */
export async function findRepoNameSanitizationCollision(
	candidateName: string,
	excludeId?: number
): Promise<string | null> {
	const candidateKey = sanitizeRepoName(candidateName);
	const repos = await getGitRepositories();
	for (const repo of repos) {
		if (excludeId != null && repo.id === excludeId) continue;
		if (sanitizeRepoName(repo.name) === candidateKey) {
			return repo.name;
		}
	}
	// A centralized clone at git-repos/shared/<name> and a per-stack env tree at
	// git-repos/<envName>/ would not collide directly, but an env named exactly
	// like the repo (or vice-versa) makes the heuristic cleanup ambiguous —
	// refuse those names outright.
	const envs = await getEnvironments();
	for (const env of envs) {
		if (sanitizeRepoName(env.name) === candidateKey) {
			return env.name;
		}
	}
	return null;
}

interface GitEnv {
	[key: string]: string;
}

const NSS_WRAPPER_LIB = '/usr/lib/libnss_wrapper.so';
const TMP_PASSWD = '/tmp/dockhand-passwd';
const TMP_GROUP = '/tmp/dockhand-group';

// Cache the check so we only do it once per process
let _nssWrapperChecked = false;
let _nssWrapperNeeded = false;

/**
 * Ensures the current UID exists in /etc/passwd for git/SSH operations.
 * SSH calls getpwuid() which fails with "No user exists for uid XXXX" if the
 * UID isn't in /etc/passwd (common with Docker --user or read-only containers).
 * Creates a temp passwd file and configures LD_PRELOAD with libnss_wrapper.
 */
async function ensurePasswdEntry(env: GitEnv): Promise<void> {
	if (_nssWrapperChecked) {
		if (_nssWrapperNeeded) {
			env.LD_PRELOAD = env.LD_PRELOAD ? `${env.LD_PRELOAD}:${NSS_WRAPPER_LIB}` : NSS_WRAPPER_LIB;
			env.NSS_WRAPPER_PASSWD = TMP_PASSWD;
			env.NSS_WRAPPER_GROUP = TMP_GROUP;
		}
		return;
	}
	_nssWrapperChecked = true;

	// Check if current UID is in /etc/passwd
	const uid = process.getuid?.();
	if (uid === undefined || uid === 0) return; // root or not available

	try {
		const passwd = readFileSync('/etc/passwd', 'utf-8');
		const uidStr = `:${uid}:`;
		if (passwd.split('\n').some(line => {
			const parts = line.split(':');
			return parts[2] === String(uid);
		})) {
			return; // UID exists, nothing to do
		}
	} catch {
		return; // can't read passwd, bail
	}

	// UID not found — check if libnss_wrapper is available
	if (!existsSync(NSS_WRAPPER_LIB)) {
		console.warn(`[git] UID ${uid} not in /etc/passwd and libnss_wrapper not found — SSH may fail`);
		return;
	}

	// Create temp passwd/group with the missing entry
	try {
		const gid = process.getgid?.() ?? uid;
		const passwd = readFileSync('/etc/passwd', 'utf-8');
		const group = readFileSync('/etc/group', 'utf-8');

		const passwdEntry = `dockhand:x:${uid}:${gid}:Dockhand:/home/dockhand:/bin/sh`;
		writeFileSync(TMP_PASSWD, passwd.trimEnd() + '\n' + passwdEntry + '\n');

		const gidExists = group.split('\n').some(line => line.split(':')[2] === String(gid));
		if (gidExists) {
			writeFileSync(TMP_GROUP, group);
		} else {
			writeFileSync(TMP_GROUP, group.trimEnd() + '\n' + `dockhand:x:${gid}:\n`);
		}

		_nssWrapperNeeded = true;
		env.LD_PRELOAD = env.LD_PRELOAD ? `${env.LD_PRELOAD}:${NSS_WRAPPER_LIB}` : NSS_WRAPPER_LIB;
		env.NSS_WRAPPER_PASSWD = TMP_PASSWD;
		env.NSS_WRAPPER_GROUP = TMP_GROUP;
		console.log(`[git] Created temp passwd for UID ${uid} with libnss_wrapper`);
	} catch (err) {
		console.warn(`[git] Failed to create temp passwd:`, err);
	}
}

export async function buildGitEnv(credential: GitCredentialData | null): Promise<GitEnv> {
	const env: GitEnv = {
		...process.env as GitEnv,
		GIT_TERMINAL_PROMPT: '0',
		// Prevent SSH agent from providing keys automatically
		SSH_AUTH_SOCK: ''
	};

	// Pass custom CA certificate to git CLI (NODE_EXTRA_CA_CERTS only affects Node.js).
	// GIT_SSL_CAINFO replaces the default CA store, so we merge system CAs with the
	// custom cert so both self-signed repos and public repos (GitHub etc.) work (#967).
	if (process.env.NODE_EXTRA_CA_CERTS) {
		env.GIT_SSL_CAINFO = getMergedCaBundlePath();
	}

	// Ensure current UID is resolvable for SSH/git operations
	await ensurePasswdEntry(env);

	// For HTTPS password/token auth, inject credentials via http.extraHeader env vars
	// instead of embedding them in the URL (which leaks via /proc/<pid>/cmdline, #1081).
	// Uses GIT_CONFIG_COUNT mechanism (git >= 2.31) to set Authorization header.
	if (credential?.authType === 'password' && (credential.username || credential.password)) {
		// Basic auth (base64 of username:password) — works with GitHub PATs, GitLab
		// tokens, Gitea tokens, and standard username/password combos. Empty username
		// is defaulted inside buildBasicAuthHeader (see #1273).
		env.GIT_CONFIG_COUNT = '1';
		env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
		env.GIT_CONFIG_VALUE_0 = buildBasicAuthHeader(credential.username || '', credential.password || '');
	}

	if (credential?.authType === 'ssh' && credential.sshPrivateKey) {
		// Write SSH key to /tmp instead of data volume — some filesystems (TrueNAS ZFS,
		// NFS, CIFS) silently ignore chmod, leaving the key group-readable (e.g. 0670).
		// SSH refuses keys that are accessible by others. /tmp is always a proper filesystem.
		// Unique per operation so concurrent syncs of the SAME credential don't share
		// one file; otherwise one op's cleanup deletes the key mid-clone of another
		// (#1413). The path is stashed in env for cleanupSshKey to remove exactly.
		const sshKeyPath = makeSshKeyPath(credential.id);

		// Ensure SSH key ends with a newline (newer SSH versions are strict about this)
		let keyContent = credential.sshPrivateKey;
		if (!keyContent.endsWith('\n')) {
			keyContent += '\n';
		}

		writeFileSync(sshKeyPath, keyContent);
		// Ensure SSH key has correct permissions (0600 = owner read/write only)
		// writeFileSync's mode option doesn't always work reliably, so use chmodSync
		chmodSync(sshKeyPath, 0o600);

		// If key has a passphrase, decrypt it in-place so SSH can use it non-interactively
		if (credential.sshPassphrase) {
			const result = spawnSync(
				'ssh-keygen',
				['-p', '-f', sshKeyPath, '-P', credential.sshPassphrase, '-N', ''],
				{ env, stdio: ['pipe', 'pipe', 'pipe'] }
			);
			if (result.status !== 0) {
				const stderr = result.stderr.toString().trim();
				console.warn(`[git] Failed to decrypt SSH key: ${stderr}`);
			}
		}

		// Configure SSH to use ONLY this key (no agent, no default keys)
		env.GIT_SSH_COMMAND = `ssh -i "${sshKeyPath}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes`;
		env[GIT_SSH_KEY_PATH_ENV] = sshKeyPath;
	} else {
		// No SSH credential - prevent using any keys (IdentitiesOnly=yes with no -i means no keys)
		env.GIT_SSH_COMMAND = 'ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes -o PasswordAuthentication=no -o PubkeyAuthentication=no';
	}

	return env;
}

export function cleanupSshKey(credential: GitCredentialData | null, env?: GitEnv): void {
	if (credential?.authType === 'ssh') {
		// Removes the exact per-operation key this env created; falls back to the old
		// deterministic path only if no env is available (legacy callers). See #1413.
		removeSshKey(credential.id, env);
	}
}

export function buildRepoUrl(url: string, credential: GitCredentialData | null): string {
	assertSafeRepoUrl(url);
	// Never embed credentials in the URL — they leak via /proc/<pid>/cmdline (see #1081).
	// HTTPS credentials are injected via GIT_CONFIG_COUNT env vars in buildGitEnv().
	// Strip any existing credentials from the URL for safety.
	if (credential?.authType === 'password' && !url.startsWith('git@')) {
		try {
			const parsed = new URL(url);
			parsed.username = '';
			parsed.password = '';
			return parsed.toString();
		} catch {
			return url;
		}
	}
	return url;
}

export async function execGit(
	args: string[],
	cwd: string,
	env: GitEnv,
	timeoutMs?: number
): Promise<{ stdout: string; stderr: string; code: number }> {
	let proc: ReturnType<typeof nodeSpawn> | undefined;
	try {
		proc = nodeSpawn('git', args, {
			cwd,
			env,
			stdio: ['pipe', 'pipe', 'pipe']
		});

		// Bounds a hung git subprocess (e.g. a frozen SSH connection during a
		// clone). The child is SIGKILLed on timeout so the concurrency slot is
		// genuinely released — a bare Promise.race would free the slot while the
		// clone keeps running, defeating the point of the cap.
		let timer: ReturnType<typeof setTimeout> | undefined;
		if (timeoutMs && timeoutMs > 0) {
			timer = setTimeout(() => {
				console.error(`[Git] git ${args[0] ?? ''} timed out after ${timeoutMs}ms — killing subprocess`);
				try { proc?.kill('SIGKILL'); } catch { /* already gone */ }
			}, timeoutMs);
		}

		const result = await collectProcess(proc);
		if (timer) clearTimeout(timer);

		return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), code: result.exitCode };
	} catch (err: any) {
		return { stdout: '', stderr: err.message, code: 1 };
	}
}

/**
 * Get list of files that changed between two commits in a specific directory.
 * Returns array of changed file paths (relative to repo root).
 */
export async function getChangedFilesInDir(
	repoPath: string,
	previousCommit: string | null,
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

/**
 * Compute the deletion plan for a sync: hash the new clone's compose dir and
 * diff against the manifest from the last sync. Deletions converge the deploy
 * dir toward the clone state; the applier additionally verifies each file's
 * disk hash. A sanity guard blocks ALL deletions when the clone walk looks
 * broken (empty, or missing the compose file).
 */
export async function computeSyncDeletionPlan(options: {
	logPrefix: string;
	composeDir: string; // absolute path inside the clone
	composeFileName: string | undefined; // compose file relative to composeDir
	rawManifest: string | null | undefined;
}): Promise<{ plan: DeletionPlan; newFiles: Record<string, string>; previousManifest: SyncManifest }> {
	const { logPrefix, composeDir, composeFileName, rawManifest } = options;

	const previousManifest = parseManifest(rawManifest);
	const newFiles = hashDirFiles(composeDir);

	const manifestSize = Object.keys(previousManifest.files).length;
	console.log(`${logPrefix} Deletion sync: manifest has ${manifestSize} file(s)${manifestSize === 0 ? ' (first sync — nothing will be deleted)' : ''}`);

	// First sync / legacy manifest: nothing was recorded, so nothing can be deleted
	if (manifestSize === 0) {
		return { plan: { toDelete: [], skipped: [] }, newFiles, previousManifest };
	}

	const blocked = deletionSafetyCheck(previousManifest.files, newFiles, composeFileName);
	if (blocked) {
		console.warn(`${logPrefix} Deletion sync: ${blocked}`);
		return { plan: { toDelete: [], skipped: [] }, newFiles, previousManifest };
	}

	const plan = computeDeletions(previousManifest.files, newFiles);

	for (const file of plan.toDelete) {
		console.log(`${logPrefix} Deletion sync: will remove "${file.path}" — deleted from the repository`);
	}
	for (const skip of plan.skipped) {
		console.warn(`${logPrefix} Deletion sync: keeping "${skip.path}" — ${skipReasonMessage(skip.reason)}`);
	}

	return { plan, newFiles, previousManifest };
}

/**
 * Persist the manifest after a deploy and log the per-file change summary.
 * Called only after a successful deploy (locally applied or agent-confirmed).
 * Progress popovers show the plan-based change table before the deploy
 * instead (#1260); this summary (with real apply results) goes to the
 * server log only.
 */
export async function finalizeDeletionSync(options: {
	stackId: number;
	logPrefix: string;
	previousManifest: SyncManifest;
	newCommitFull: string;
	newFiles: Record<string, string>;
	plan: DeletionPlan;
	applyResult: DeletionApplyResult | undefined;
}): Promise<void> {
	const { stackId, logPrefix, previousManifest, newCommitFull, newFiles, plan, applyResult } = options;

	// No apply result means deletions were requested but nothing reported back
	// (defensive — executors always return one). Logged as skips; skips are final.
	const effectiveApply: DeletionApplyResult = applyResult ?? {
		deleted: [],
		skipped: plan.toDelete.map((f): DeletionSkip => ({ path: f.path, reason: 'apply-failed' }))
	};

	// Pass only the plan-stage skips; buildSyncChangeSummary already merges
	// in effectiveApply.skipped itself. Concatenating here duplicated every
	// apply-stage skip (locally-modified, agent-no-support, apply-failed).
	const summary = buildSyncChangeSummary(previousManifest.files, newFiles, effectiveApply, plan.skipped);
	const tableLines = formatChangeTable(summary);

	console.log(`${logPrefix} Sync file changes: ${tableLines[0]}`);
	for (const line of tableLines.slice(1)) {
		console.log(`${logPrefix}   ${line}`);
	}

	const nextManifest = buildNextManifest(newCommitFull, newFiles);
	const { updateGitStack } = await import('./db');
	await updateGitStack(stackId, { syncedFiles: serializeManifest(nextManifest) });
	console.log(`${logPrefix} Manifest persisted: ${Object.keys(nextManifest.files).length} file(s) at commit ${nextManifest.commit?.substring(0, 7)}`);
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
	// Deletion sync (#966/#1162): manifest-vs-clone data
	deletionPlan?: DeletionPlan; // Files safe to delete (manifest entries absent from the new clone) + plan-stage skips
	newFiles?: Record<string, string>; // path → sha256 of files in the new clone (next manifest)
	newCommitFull?: string; // Full 40-char commit hash (manifest commit)
	previousManifest?: SyncManifest; // Manifest from the last successful sync
}

export interface TestResult {
	success: boolean;
	branch?: string;
	lastCommit?: string;
	composeFileExists?: boolean;
	error?: string;
}

// Progress callback type
export type ProgressCallback = (data: {
	status: 'connecting' | 'cloning' | 'fetching' | 'reading' | 'deploying' | 'complete' | 'error';
	message?: string;
	step?: number;
	totalSteps?: number;
	error?: string;
}) => void;

export type DeployGitStackResult = {
	success: boolean;
	output?: string;
	error?: string;
	skipped?: boolean;
};

export type FanOutResult = {
	success: boolean;
	output?: string;
	error?: string;
	stacks?: Array<{ id: number; name: string; status: 'deployed' | 'skipped' | 'failed'; error?: string }>;
};

/**
 * Clean up git/SSH error messages for user display
 */
export function cleanGitError(stderr: string): string {
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
export async function testRepositoryConnection(options: {
	url: string;
	branch: string;
	credential: GitCredentialData | null;
}): Promise<TestResult> {
	const { url, branch, credential } = options;

	const env = await buildGitEnv(credential);
	assertSafeGitRef(branch);
	const repoUrl = buildRepoUrl(url, credential);

	try {
		// Use git ls-remote to test connection and verify branch
		const result = await execGit(
			['ls-remote', '--heads', '--refs', repoUrl, branch || 'HEAD'],
			process.cwd(),
			env
		);

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
		return { success: false, error: error.message };
	} finally {
		cleanupSshKey(credential, env);
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

/**
 * Fire the git_sync_success / git_sync_failed / git_sync_skipped notification for a
 * git-stack deploy. Best-effort: never changes the deploy outcome.
 */
export async function notifyGitSync(stackName: string, envId: number | null | undefined, result: { success: boolean; error?: string; skipped?: boolean }): Promise<void> {
	try {
		if (result.success && result.skipped) {
			await sendEventNotification('git_sync_skipped', {
				title: 'Git sync skipped',
				message: `Stack "${stackName}" sync skipped: no changes detected`,
				type: 'info'
			}, envId ?? undefined);
		} else if (result.success) {
			await sendEventNotification('git_sync_success', {
				title: 'Git stack deployed',
				message: `Stack "${stackName}" was synced and deployed successfully`,
				type: 'success'
			}, envId ?? undefined);
		} else {
			await sendEventNotification('git_sync_failed', {
				title: 'Git sync failed',
				message: `Stack "${stackName}" sync failed: ${result.error || 'unknown error'}`,
				type: 'error'
			}, envId ?? undefined);
		}
	} catch { /* never changes the deploy outcome */ }
}

/**
 * Test a git stack's repository connection (mode-agnostic — uses ls-remote,
 * does not touch any clone directory).
 */
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
	assertSafeGitRef(repo.branch);
	const repoUrl = buildRepoUrl(repo.url, credential);

	try {
		// Use git ls-remote to test connection and get branch info
		const result = await execGit(
			['ls-remote', '--heads', '--refs', repoUrl, repo.branch],
			process.cwd(),
			env
		);

		cleanupSshKey(credential, env);

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

		return {
			success: true,
			branch,
			lastCommit
		};
	} catch (error: any) {
		cleanupSshKey(credential, env);
		return { success: false, error: error.message };
	}
}

/**
 * Returns the absolute path where a centralized repository is (or will be) cloned.
 * Used by the browse API to validate that requested paths stay within the repo root.
 * Only meaningful in centralized mode (browse is disabled in stack mode).
 */
export function deleteRepositoryFiles(repoName: string, repoId?: number): void {
	const repoPath = getRepoPath(repoName);
	try {
		if (existsSync(repoPath)) {
			rmSync(repoPath, { recursive: true, force: true });
		}
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error('[Git] Failed to delete repository files:', errorMsg);
	}
	// Also clean up any pre-shared repo-{id} directory left from the old layout
	if (repoId !== undefined) {
		const oldPath = join(GIT_REPOS_DIR, `repo-${repoId}`);
		try {
			if (existsSync(oldPath)) {
				rmSync(oldPath, { recursive: true, force: true });
			}
		} catch {
			// Ignore cleanup errors
		}
	}
}

/**
 * Rename the on-disk clone directory when a repository is renamed.
 * No-op if sanitized paths are identical or the source dir is missing.
 */
export function renameRepositoryFiles(oldName: string, newName: string): void {
	const oldPath = getRepoPath(oldName);
	const newPath = getRepoPath(newName);
	if (oldPath === newPath) return;
	if (!existsSync(oldPath)) return;
	if (existsSync(newPath)) {
		console.warn(`[Git] Cannot rename repo dir ${oldPath} -> ${newPath}: target already exists`);
		return;
	}
	try {
		renameSync(oldPath, newPath);
		console.log(`[Git] Renamed repo dir ${oldPath} -> ${newPath}`);
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error('[Git] Failed to rename repository files:', errorMsg);
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
		const value = trimmed.substring(eqIndex + 1).trim();

		// Only add if key is valid env var name
		if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			result[key] = value;
		} else {
			invalidKeys.push(`Line ${i + 1}: "${key}" (invalid key format)`);
		}
	}

	console.log(`${logPrefix} Parsed env vars count:`, Object.keys(result).length);
	console.log(`${logPrefix} Parsed env var keys:`, Object.keys(result).join(', '));
	console.log(`${logPrefix} Parsed env vars (masked):`, JSON.stringify(redactEnvVarsForLog(result), null, 2));
	if (skippedLines.length > 0) {
		console.log(`${logPrefix} Skipped lines (${skippedLines.length}):`, skippedLines.slice(0, 10).join('; '));
	}
	if (invalidKeys.length > 0) {
		console.log(`${logPrefix} Invalid keys (${invalidKeys.length}):`, invalidKeys.join('; '));
	}

	return result;
}

interface PreviewEnvOptions {
	repoUrl: string;
	branch: string;
	credential: {
		id: number;
		authType: string;
		sshPrivateKey?: string | null;
		username?: string | null;
		password?: string | null;
	} | null;
	composePath: string;
	envFilePath: string | null;
}

interface PreviewEnvResult {
	vars: Record<string, string>;
	sources: Record<string, '.env' | 'envFile'>;
	error?: string;
}

/**
 * Clone a repository to a temp directory and read env files for preview.
 * Used to populate env editor when creating a new git stack.
 * Cleans up temp directory after reading.
 */
export async function previewRepoEnvFiles(options: PreviewEnvOptions): Promise<PreviewEnvResult> {
	const { repoUrl, branch, credential, composePath, envFilePath } = options;
	const logPrefix = '[Git:Preview]';

	// Create a unique temp directory
	const tempId = `preview-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
	const tempDir = join(GIT_REPOS_DIR, tempId);

	console.log(`${logPrefix} Starting preview for ${repoUrl}`);
	console.log(`${logPrefix} Temp directory: ${tempDir}`);

	// Declared outside the try so the finally can pass it to cleanupSshKey (#1413):
	// a block-scoped `const env` inside the try is out of scope in finally, which
	// throws "env is not defined" before the real result/error is returned.
	let env: GitEnv | undefined;

	try {
		// Ensure temp directory exists
		mkdirSync(tempDir, { recursive: true });

		// Build git environment with credentials
		// Cast credential to GitCredential type (only uses id, authType, sshPrivateKey)
		env = await buildGitEnv(credential as GitCredentialData | null);
		assertSafeGitRef(branch);
		const authenticatedUrl = buildRepoUrl(repoUrl, credential as GitCredentialData | null);

		// Clone with depth 1 (shallow clone for speed)
		const cloneProc = nodeSpawn(
			'git',
			['clone', '--depth', '1', '--branch', branch, '--single-branch', authenticatedUrl, tempDir],
			{
				stdio: ['pipe', 'pipe', 'pipe'],
				env
			}
		);

		const cloneResult = await collectProcess(cloneProc);
		const cloneStderr = cloneResult.stderr;
		const cloneExitCode = cloneResult.exitCode;

		if (cloneExitCode !== 0) {
			console.error(`${logPrefix} Clone failed:`, cloneStderr);
			return { vars: {}, sources: {}, error: `Failed to clone repository: ${cloneStderr.trim()}` };
		}

		console.log(`${logPrefix} Clone successful`);

		// Determine the compose directory (where .env file should be)
		const composeDir = dirname(composePath);
		const baseEnvPath = join(tempDir, composeDir, '.env');

		const vars: Record<string, string> = {};
		const sources: Record<string, '.env' | 'envFile'> = {};

		// Read base .env file if it exists
		if (existsSync(baseEnvPath)) {
			console.log(`${logPrefix} Reading .env from: ${baseEnvPath}`);
			const content = readFileSync(baseEnvPath, 'utf-8');
			const baseVars = parseEnvFileContent(content, 'preview');
			for (const [key, value] of Object.entries(baseVars)) {
				vars[key] = value;
				sources[key] = '.env';
			}
			console.log(`${logPrefix} Found ${Object.keys(baseVars).length} vars in .env`);
		} else {
			console.log(`${logPrefix} No .env file at ${baseEnvPath}`);
		}

		// Read additional env file if specified
		if (envFilePath) {
			const additionalEnvPath = join(tempDir, envFilePath);
			if (existsSync(additionalEnvPath)) {
				console.log(`${logPrefix} Reading additional env file: ${additionalEnvPath}`);
				const content = readFileSync(additionalEnvPath, 'utf-8');
				const additionalVars = parseEnvFileContent(content, 'preview');
				for (const [key, value] of Object.entries(additionalVars)) {
					vars[key] = value;
					sources[key] = 'envFile';
				}
				console.log(`${logPrefix} Found ${Object.keys(additionalVars).length} vars in ${envFilePath}`);
			} else {
				console.log(`${logPrefix} Additional env file not found: ${additionalEnvPath}`);
			}
		}

		console.log(`${logPrefix} Total variables: ${Object.keys(vars).length}`);

		return { vars, sources };
	} catch (error: any) {
		console.error(`${logPrefix} Error:`, error);
		return { vars: {}, sources: {}, error: error.message };
	} finally {
		// Always clean up temp directory
		cleanupSshKey(credential as GitCredentialData | null, env);
		try {
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
				console.log(`${logPrefix} Cleaned up temp directory`);
			}
		} catch (cleanupError) {
			console.error(`${logPrefix} Failed to cleanup temp directory:`, cleanupError);
		}
	}
}

// =============================================================================
// SEALED ENGINES + MODE-DISPATCHING FACADE
// =============================================================================

/**
 * A sealed git engine. Stack and centralized engines share NO mutable path or
 * sync helpers with each other (F5) — only the plumbing in this module.
 */
export interface GitEngine {
	syncGitStack(stackId: number, onProgress?: ProgressCallback): Promise<SyncResult>;
	deployGitStack(stackId: number, options?: { force?: boolean; ignoreForceRedeploy?: boolean }): Promise<DeployGitStackResult>;
	deployGitStackWithProgress(stackId: number, onProgress: ProgressCallback): Promise<DeployGitStackResult>;
	deleteGitStackFiles(stackId: number, stackName?: string, environmentId?: number | null): Promise<void>;
	listGitStackEnvFiles(stackId: number): Promise<{ files: string[]; error?: string }>;
	readGitStackEnvFile(stackId: number, envFilePath: string): Promise<{ vars: Record<string, string>; error?: string }>;
	// Repository-level operations (centralized only).
	syncRepository?(repoId: number): Promise<SyncResult>;
	syncRepositoryExclusive?(repoId: number): Promise<SyncResult>;
	deployFromRepositoryWithFanOut?(repositoryId: number, log?: (msg: string) => void, stackIds?: number[]): Promise<FanOutResult>;
	checkForUpdates?(repoId: number): Promise<{ hasUpdates: boolean; currentCommit?: string; latestCommit?: string; error?: string }>;
}

/**
 * Resolve an engine instance for the given mode (default: stack). Stack-level
 * operations use getEngineForStack()/getEngineForRepository() so dispatch
 * follows each stack's engine, captured once per top-level operation so a
 * mid-flight migrate cannot split-brain a single call (per-stack F9).
 */
export async function getEngine(mode?: GitMode): Promise<GitEngine> {
	const effectiveMode = mode ?? (await getGitMode());
	if (effectiveMode === 'centralized') {
		const { CentralizedGitEngine } = await import('./git-centralized');
		return CentralizedGitEngine;
	}
	const { StackGitEngine } = await import('./git-stack');
	return StackGitEngine;
}

/**
 * Resolve the engine for a git stack from its own engine ('centralized' or
 * 'stack'). The model is read once per top-level operation, so a concurrent
 * migrate cutting over mid-operation cannot split-brain that call (per-stack
 * F9). Rows missing a model (should not happen post-0012 backfill) fall back
 * to the stack engine.
 */
export async function getEngineForStack(stackId: number): Promise<GitEngine> {
	const { getGitStack } = await import('./db');
	const stack = await getGitStack(stackId);
	if (stack) {
		return getEngine(stack.engine);
	}
	// No stack row (mid-delete) — default to the stack engine to keep delete
	// lifecycle code safe.
	return getEngine('stack');
}

/**
 * Resolve the engine for repo-level operations from membership: the
 * centralized engine only when the repository has at least one
 * engine='centralized' stack. Otherwise the stack engine answers, which has
 * no repo-level methods and reproduces today's "not available in stack mode"
 * errors. Mirrors the repo-level existence check used by the scheduler.
 */
export async function getEngineForRepository(repositoryId: number): Promise<GitEngine> {
	const { getFullGitStacksByRepositoryId } = await import('./db');
	const stacks = await getFullGitStacksByRepositoryId(repositoryId);
	const hasCentralized = stacks.some((s) => s.engine === 'centralized');
	return hasCentralized ? getEngine('centralized') : getEngine('stack');
}

export async function syncGitStack(stackId: number, onProgress?: ProgressCallback): Promise<SyncResult> {
	return (await getEngineForStack(stackId)).syncGitStack(stackId, onProgress);
}

export async function deployGitStack(
	stackId: number,
	options?: { force?: boolean; ignoreForceRedeploy?: boolean }
): Promise<DeployGitStackResult> {
	return (await getEngineForStack(stackId)).deployGitStack(stackId, options);
}

export async function deployGitStackWithProgress(
	stackId: number,
	onProgress: ProgressCallback
): Promise<DeployGitStackResult> {
	return (await getEngineForStack(stackId)).deployGitStackWithProgress(stackId, onProgress);
}

export async function deleteGitStackFiles(stackId: number, stackName?: string, environmentId?: number | null): Promise<void> {
	return (await getEngineForStack(stackId)).deleteGitStackFiles(stackId, stackName, environmentId);
}

export async function listGitStackEnvFiles(stackId: number): Promise<{ files: string[]; error?: string }> {
	return (await getEngineForStack(stackId)).listGitStackEnvFiles(stackId);
}

export async function readGitStackEnvFile(stackId: number, envFilePath: string): Promise<{ vars: Record<string, string>; error?: string }> {
	return (await getEngineForStack(stackId)).readGitStackEnvFile(stackId, envFilePath);
}

export async function syncRepository(repoId: number): Promise<SyncResult> {
	const engine = await getEngineForRepository(repoId);
	if (!engine.syncRepository) {
		return { success: false, error: 'Repository-level sync is not available in stack mode' };
	}
	return engine.syncRepository(repoId);
}

export async function syncRepositoryExclusive(repoId: number): Promise<SyncResult> {
	const engine = await getEngineForRepository(repoId);
	if (!engine.syncRepositoryExclusive) {
		return { success: false, error: 'Repository-level sync is not available in stack mode' };
	}
	return engine.syncRepositoryExclusive(repoId);
}

/**
 * Provision/refresh the shared clone for a repository WITHOUT the membership
 * gate — used by the centralized create path and the per-stack migrate job
 * while a repo has zero centralized stacks yet (provisioning phase).
 */
export async function provisionSharedClone(repoId: number): Promise<SyncResult> {
	const { CentralizedGitEngine } = await import('./git-centralized');
	return CentralizedGitEngine.syncRepositoryExclusive!(repoId);
}

export async function deployFromRepositoryWithFanOut(
	repositoryId: number,
	log?: (msg: string) => void,
	stackIds?: number[]
): Promise<FanOutResult> {
	const engine = await getEngineForRepository(repositoryId);
	if (!engine.deployFromRepositoryWithFanOut) {
		return { success: false, error: 'Repository-level webhooks are not available in stack mode', stacks: [] };
	}
	return engine.deployFromRepositoryWithFanOut(repositoryId, log, stackIds);
}

export async function checkForUpdates(repoId: number): Promise<{ hasUpdates: boolean; currentCommit?: string; latestCommit?: string; error?: string }> {
	const engine = await getEngineForRepository(repoId);
	if (!engine.checkForUpdates) {
		return { hasUpdates: false, error: 'Repository-level update checks are not available in stack mode' };
	}
	return engine.checkForUpdates(repoId);
}

// Centralized-only lifecycle helper, re-exported for the environments route.
// Mode-gated inside git-centralized.ts so stack-mode installs are never cleaned
// up by the heuristic sweep (F10). Per-stack clone cleanup now lives in the
// per-stack migrate job (git-stack-migrate.ts) — see Phase 4.
export { cleanupEnvGitReposDir } from './git-centralized';

// Re-export shared types used across the codebase.
export type { GitMode };
