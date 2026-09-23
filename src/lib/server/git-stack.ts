import { existsSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getGitRepository, getGitCredential } from './db';
import { assertSafeGitRef } from './git-url-safety';
import { buildGitEnv, cleanupSshKey, buildRepoUrl, execGit, getGitReposDir } from './git';

// A stalled network/SSH clone must not hold a create-flow request forever.
const STACK_CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const PENDING_CLONE_PREFIX = 'pending-';
const PENDING_CLONE_TOKEN = /^[a-f0-9-]+$/;
const PENDING_CLONE_METADATA_SUFFIX = '.json';

interface PendingCloneRecord {
	token: string;
	repositoryId: number;
	branch: string;
	createdAt: number;
}

function pendingClonePath(token: string): string {
	return join(getGitReposDir(), `${PENDING_CLONE_PREFIX}${token}`);
}

function pendingCloneMetadataPath(token: string): string {
	return join(getGitReposDir(), `${PENDING_CLONE_PREFIX}${token}${PENDING_CLONE_METADATA_SUFFIX}`);
}

function readPendingClone(token: string): PendingCloneRecord | null {
	if (!PENDING_CLONE_TOKEN.test(token)) return null;
	try {
		const record = JSON.parse(readFileSync(pendingCloneMetadataPath(token), 'utf-8')) as PendingCloneRecord;
		if (
			record.token !== token ||
			typeof record.repositoryId !== 'number' ||
			typeof record.branch !== 'string' ||
			typeof record.createdAt !== 'number' ||
			!existsSync(pendingClonePath(token))
		) return null;
		return record;
	} catch {
		return null;
	}
}

function cleanupPendingClone(token: string): void {
	try { rmSync(pendingClonePath(token), { recursive: true, force: true }); } catch { /* best effort */ }
	try { rmSync(pendingCloneMetadataPath(token), { force: true }); } catch { /* best effort */ }
}

/** Remove abandoned create-flow checkouts without touching stack-owned clones. */
function cleanupPendingGitClones(maxAgeMs = 24 * 60 * 60 * 1000): void {
	const cutoff = Date.now() - maxAgeMs;
	try {
		for (const name of readdirSync(getGitReposDir())) {
			if (!name.startsWith(PENDING_CLONE_PREFIX) || !name.endsWith(PENDING_CLONE_METADATA_SUFFIX)) continue;
			const token = name.slice(PENDING_CLONE_PREFIX.length, -PENDING_CLONE_METADATA_SUFFIX.length);
			const record = readPendingClone(token);
			if (!record || record.createdAt < cutoff) cleanupPendingClone(token);
		}
	} catch {
		// Cleanup is opportunistic; clone and deployment correctness do not depend on it.
	}
}

/** Clone a repository for the Git-stack create flow, outside any stack directory. */
export async function cloneGitRepositoryToPending(
	repositoryId: number,
	branchOverride?: string | null
): Promise<{ success: boolean; token?: string; commit?: string; error?: string }> {
	cleanupPendingGitClones();
	const repo = await getGitRepository(repositoryId);
	if (!repo) return { success: false, error: 'Repository not found' };

	const branch = branchOverride?.trim() || repo.branch;
	const credential = repo.credentialId ? await getGitCredential(repo.credentialId) : null;
	const token = randomUUID();
	const clonePath = pendingClonePath(token);
	const env = await buildGitEnv(credential);
	try {
		assertSafeGitRef(branch);
		const repoUrl = buildRepoUrl(repo.url, credential);
		const result = await execGit(
			['clone', '--filter=blob:none', '--branch', branch, repoUrl, clonePath],
			process.cwd(),
			env,
			STACK_CLONE_TIMEOUT_MS
		);
		if (result.code !== 0) {
			cleanupPendingClone(token);
			return { success: false, error: `Git clone failed: ${result.stderr}` };
		}

		const commitResult = await execGit(['rev-parse', 'HEAD'], clonePath, env);
		const commit = commitResult.code === 0 ? commitResult.stdout.trim() : undefined;
		const record: PendingCloneRecord = { token, repositoryId, branch, createdAt: Date.now() };
		writeFileSync(pendingCloneMetadataPath(token), JSON.stringify(record));
		return { success: true, token, commit };
	} catch (error: any) {
		cleanupPendingClone(token);
		return { success: false, error: error?.message || String(error) };
	} finally {
		cleanupSshKey(credential, env);
	}
}

/** Resolve a pending checkout only when its token belongs to the requested repo. */
export function getPendingGitClonePath(token: string, repositoryId: number): string | null {
	const record = readPendingClone(token);
	return record?.repositoryId === repositoryId ? pendingClonePath(token) : null;
}
