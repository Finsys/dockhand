import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { statSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, isAbsolute, relative } from 'node:path';
import { getGitRepository, getGitStack } from '$lib/server/db';
import { getStackRepoPath } from '$lib/server/git';
import { getPendingGitClonePath } from '$lib/server/git-stack';
import { authorize } from '$lib/server/authorize';
import { isPathUnderRoot } from '$lib/server/stack-path-utils';

interface FileEntry {
	name: string;
	/** Path relative to the repository root ('' = root). Never absolute. */
	path: string;
	type: 'file' | 'directory' | 'symlink';
	size: number;
	mtime: string;
	mode: string;
}

/**
 * @openapi
 * summary: List a directory of a repository checkout (a create-flow pending clone, or a Git stack's deployed clone) to pick compose files
 * description: Exactly one of pending or stackId selects the checkout. All paths in the response are relative to the repository root, so the host filesystem layout is never exposed. Absolute paths, traversal, symlink escapes and .git are rejected.
 * path: id:integer! Git repository ID (from GET /api/git/repositories)
 * query: pending:string Token returned by POST /api/git/repositories/{id}/temporary-clone
 * query: stackId:integer Git stack ID whose deployed clone to browse (must belong to this repository)
 * query: path:string Repository-relative directory to list (defaults to the root)
 * resp-200: {path:string!, parent:string, entries:array<{name:string!, path:string!, type:string!, size:integer!, mtime:string!, mode:string!}>!}
 * resp-400: Invalid repository ID, absolute path, missing pending/stackId, or the path is not a directory
 * resp-403: Permission denied (needs git:view; with stackId also stacks:view), or the path escapes the repository
 * resp-404: Repository, pending checkout, Git stack, deployed clone or path not found
 * resp-500: Failed to list the directory
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const id = parseInt(params.id);
	if (isNaN(id)) {
		return json({ error: 'Invalid repository ID' }, { status: 400 });
	}
	const repo = await getGitRepository(id);
	if (!repo) {
		return json({ error: 'Repository not found' }, { status: 404 });
	}

	const pendingToken = url.searchParams.get('pending');
	const stackIdRaw = url.searchParams.get('stackId');
	let repoRoot: string;

	if (pendingToken) {
		// Create-flow checkouts are already cloned and are scoped to this repo.
		const pendingPath = getPendingGitClonePath(pendingToken, id);
		if (!pendingPath) return json({ error: 'Pending repository checkout not found or expired' }, { status: 404 });
		repoRoot = pendingPath;
	} else if (stackIdRaw) {
		const stackId = Number(stackIdRaw);
		const gitStack = Number.isInteger(stackId) ? await getGitStack(stackId) : null;
		if (!gitStack || gitStack.repositoryId !== id) {
			return json({ error: 'Git stack not found' }, { status: 404 });
		}
		if (auth.authEnabled && !await auth.can('stacks', 'view', gitStack.environmentId || undefined)) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}
		repoRoot = await getStackRepoPath(gitStack.id, gitStack.stackName, gitStack.environmentId);
		if (!existsSync(repoRoot)) return json({ error: 'Repository has not been deployed yet' }, { status: 404 });
	} else {
		return json({ error: 'A pending clone or stack ID is required' }, { status: 400 });
	}

	// Resolve the requested path (default to repo root). Absolute paths are
	// rejected outright: responses are always relative to the repo root, so
	// there is no legitimate absolute-path input, and accepting host paths
	// would leak host-path existence via the 404/403 split below.
	const requestedPath = url.searchParams.get('path') || '';
	let targetPath: string;

	if (!requestedPath || requestedPath === '/') {
		targetPath = repoRoot;
	} else if (isAbsolute(requestedPath)) {
		return json({ error: 'Absolute paths are not supported; use a repo-relative path' }, { status: 400 });
	} else {
		targetPath = join(repoRoot, requestedPath);
	}

	// Resolve to eliminate any `..` components, then guard against traversal.
	// The lexical containment check runs BEFORE the filesystem probe so a
	// crafted `../..` path can never be used as a host path-existence oracle
	// (a path outside the root is denied regardless of whether it exists).
	const resolvedTarget = resolve(targetPath);
	if (!isPathUnderRoot(resolvedTarget, resolve(repoRoot))) {
		return json({ error: 'Access denied: path is outside repository root' }, { status: 403 });
	}
	if (!existsSync(resolvedTarget)) {
		return json({ error: 'Path not found' }, { status: 404 });
	}

	let realRoot: string;
	let realTarget: string;
	try {
		realRoot = realpathSync(repoRoot);
		realTarget = realpathSync(resolvedTarget);
	} catch {
		return json({ error: 'Access denied: unable to resolve path' }, { status: 403 });
	}
	if (!isPathUnderRoot(realTarget, realRoot)) {
		return json({ error: 'Access denied: path is outside repository root' }, { status: 403 });
	}

	// Never expose git internals, even when requested directly (the listing
	// below hides .git, but a crafted request could still target it).
	const gitDir = join(realRoot, '.git');
	if (isPathUnderRoot(realTarget, gitDir)) {
		return json({ error: 'Access denied: .git is not browsable' }, { status: 403 });
	}

	const stat = statSync(realTarget);
	if (!stat.isDirectory()) {
		return json({ error: 'Not a directory' }, { status: 400 });
	}

	try {
		const entries: FileEntry[] = [];
		const dirEntries = readdirSync(realTarget, { withFileTypes: true });

		for (const entry of dirEntries) {
			// Hide the .git directory from the browser
			if (entry.name === '.git') continue;

			try {
				const fullPath = join(realTarget, entry.name);
				const entryStat = statSync(fullPath);

				entries.push({
					name: entry.name,
					path: relative(realRoot, fullPath),
					type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
					size: entryStat.size,
					mtime: entryStat.mtime.toISOString(),
					mode: (entryStat.mode & 0o777).toString(8).padStart(3, '0')
				});
			} catch {
				// Skip entries we can't stat
			}
		}

		// Sort: directories first, then alphabetically
		entries.sort((a, b) => {
			if (a.type === 'directory' && b.type !== 'directory') return -1;
			if (a.type !== 'directory' && b.type === 'directory') return 1;
			return a.name.localeCompare(b.name);
		});

		return json({
			path: relative(realRoot, realTarget),
			parent: realTarget === realRoot ? null : relative(realRoot, resolve(realTarget, '..')),
			entries
		});
	} catch (error) {
		console.error('[BrowseAPI] Error listing directory:', error);
		return json({ error: 'Failed to list directory' }, { status: 500 });
	}
};
