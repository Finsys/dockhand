import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { statSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, isAbsolute, relative } from 'node:path';
import { getGitRepository, repositoryHasCentralizedStack, getGitStacksByRepositoryId } from '$lib/server/db';
import { syncRepositoryExclusive, provisionSharedClone, getRepoPath } from '$lib/server/git';
import { getDesiredGitMode } from '$lib/server/git-mode';
import { assertNotMigrating } from '$lib/server/git-migration-guard';
import { authorize } from '$lib/server/authorize';
import { isPathUnderRoot } from '$lib/server/path-utils';

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
 * GET /api/git/repositories/:id/browse?path=
 *
 * Lists the contents of a cloned git repository directory.
 * If the repository is not yet cloned, a blocking clone is triggered first
 * (so the first browse request is the only one that waits for cloning).
 *
 * The `path` query parameter is optional (relative to the repo root) —
 * defaults to the repository root. Absolute paths are rejected. All paths are
 * validated to stay within the clone root (no directory traversal, no symlink
 * escape, no .git internals).
 *
 * All paths in the response are RELATIVE to the repository root, so the
 * host filesystem layout (DATA_DIR etc.) is never exposed.
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Block only while THIS repository is being provisioned by a migration — the
	// blocking sync below could otherwise race a clone mid-provision.
	const id = parseInt(params.id);
	if (isNaN(id)) {
		return json({ error: 'Invalid repository ID' }, { status: 400 });
	}
	const locked = await assertNotMigrating([], [id]);
	if (locked) return locked;

	const repo = await getGitRepository(id);
	if (!repo) {
		return json({ error: 'Repository not found' }, { status: 404 });
	}

	// Browse operates on the shared clone — a repository-level concept. It is
	// available when the repository has at least one centralized-model stack, or
	// during centralized create provisioning: a repo with ZERO stacks under a
	// centralized default is being prepared for a new centralized stack (the
	// create flow needs the clone to pick compose paths). Repos that already
	// have stack-model stacks (and no centralized members) are NOT provisioned
	// just because the default is on.
	const hasCentralized = await repositoryHasCentralizedStack(id);
	const repoStacks = await getGitStacksByRepositoryId(id);
	const provisioning = (await getDesiredGitMode()) === 'centralized' && repoStacks.length === 0;
	if (!hasCentralized && !provisioning) {
		return json({ error: 'Repository browsing is not available for stack-mode repositories' }, { status: 404 });
	}

	const repoRoot = getRepoPath(repo.name);

	// Always sync (clone or pull) before listing so the browser shows up-to-date content.
	// syncRepositoryExclusive joins any in-flight syncs (e.g. from just adding the repository).
	console.log(`[BrowseAPI] Syncing repository ${id} before browse`);
	const syncResult = hasCentralized
		? await syncRepositoryExclusive(id)
		: await provisionSharedClone(id);
	if (!syncResult.success) {
		return json({ error: `Failed to sync repository: ${syncResult.error}` }, { status: 500 });
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
