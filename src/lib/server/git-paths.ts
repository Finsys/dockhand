/**
 * Pure git path resolution — no database, no git subprocess. Extracted so the
 * mode path-isolation rules (F2/F14) can be unit-tested without the DB driver.
 *
 * Layouts:
 *  - Centralized: git-repos/shared/<sanitizedRepoName> — isolated so it can
 *    never collide with per-stack clones.
 *  - Stack (per-stack): git-repos/stack-<id> or git-repos/<envName>/<stackName>.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dataDir = process.env.DATA_DIR || './data';
export const GIT_REPOS_DIR = resolve(process.env.GIT_REPOS_DIR || join(dataDir, 'git-repos'));

// Ensure git repos directory and the centralized `shared/` namespace exist.
// `shared/` must exist before any rename-into-it or clone-under-it runs —
// Node's renameSync requires the destination's parent directory to exist.
if (!existsSync(GIT_REPOS_DIR)) {
	mkdirSync(GIT_REPOS_DIR, { recursive: true });
}
if (!existsSync(join(GIT_REPOS_DIR, 'shared'))) {
	mkdirSync(join(GIT_REPOS_DIR, 'shared'), { recursive: true });
}

export function getGitReposDir(): string {
	return GIT_REPOS_DIR;
}

/**
 * Sanitize a repository name for use as a filesystem directory name.
 * Replaces characters unsafe on most filesystems with underscores,
 * collapses consecutive underscores, and strips leading/trailing underscores.
 */
export function sanitizeRepoName(name: string): string {
	return name
		.replace(/[^a-zA-Z0-9._-]/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_|_$/g, '') || 'repo-unknown';
}

/**
 * Centralized clone path: git-repos/shared/<sanitizedRepoName>.
 * Kept under a `shared/` subdirectory so it can never collide with per-stack
 * clones (git-repos/<envName>/<stack>, git-repos/stack-<id>) (F2).
 */
export function getRepoPath(repoName: string): string {
	const sanitized = sanitizeRepoName(repoName);
	// Guard against directory traversal via specially-crafted names (e.g. "..")
	if (sanitized === '.' || sanitized === '..' || sanitized.includes('/') || sanitized.includes('\\')) {
		throw new Error(`Invalid repository name: ${repoName}`);
	}
	return join(GIT_REPOS_DIR, 'shared', sanitized);
}

/**
 * Stack (per-stack) clone path:
 *  - git-repos/stack-<id> (fallback / older stacks)
 *  - git-repos/<envName>/<stackName> (env-scoped, consistent with internal stacks)
 * Pass the environment name explicitly (the caller resolves it from the DB).
 */
export function stackRepoPath(
	stackId: number,
	envName?: string | null,
	stackName?: string | null
): string {
	if (stackName && envName) {
		const envDir = join(GIT_REPOS_DIR, envName);
		return join(envDir, stackName);
	}
	return join(GIT_REPOS_DIR, `stack-${stackId}`);
}
