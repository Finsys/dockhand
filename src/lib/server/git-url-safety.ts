/**
 * Deny-list validation for user-supplied git repo URLs and refs, kept in its OWN
 * import-light module (no db/sqlite) so it is unit-testable. git.ts re-exports and
 * calls these before any git subprocess.
 *
 * These reject inputs that git would execute as a command / read as a local file /
 * parse as an OPTION. Every legitimate scheme (https, http, ssh, git, scp-like
 * git@host:path) passes unchanged, so this is fully backward-compatible.
 */

import { resolve, sep } from 'node:path';

export function assertSafeRepoUrl(url: string): void {
	const u = (url || '').trim();
	if (!u) throw new Error('Repository URL is required');
	// A value starting with '-' is consumed by git as an option (e.g. --upload-pack=).
	if (u.startsWith('-')) throw new Error('Invalid repository URL');
	// git's ext::/fd:: transports execute a command; file:// reads local paths.
	const lower = u.toLowerCase();
	if (lower.startsWith('ext::') || lower.startsWith('fd::') || lower.startsWith('file://')) {
		throw new Error('Unsupported repository URL transport');
	}
	// A bare local filesystem path (no scheme, no scp-like host:) is not a remote.
	if (u.startsWith('/') || u.startsWith('./') || u.startsWith('../')) {
		throw new Error('Repository URL must be a remote (https/ssh/git), not a local path');
	}
}

/** A git ref (branch/tag) must not be parseable as an option. Empty is allowed
 *  (callers fall back to a default like HEAD). */
export function assertSafeGitRef(ref: string | null | undefined): void {
	const r = (ref || '').trim();
	if (r && r.startsWith('-')) throw new Error('Invalid branch/ref name');
}

/**
 * Resolve a user-supplied path (composePath / envFilePath) INSIDE the clone dir,
 * throwing if it would ESCAPE the clone. Uses resolve-then-containment (like a plain
 * `join` + escape check): an in-repo `..` (e.g. `stacks/../compose.yml`) or a leading
 * `./` still resolve, only a path that escapes the clone is refused. A leading `/` is
 * treated as repo-root-relative (`/qbittorrent/compose.yaml` -> `qbittorrent/compose.yaml`)
 * since the clone is the root the user reasons about; the containment check below still
 * blocks any real escape (`/../x` -> `../x` -> refused). `label` names the field for the
 * error message.
 */
export function repoFilePath(repoPath: string, userRel: string, label: string): string {
	const rel = userRel.replace(/^\/+/, '');
	const abs = resolve(repoPath, rel);
	if (abs !== repoPath && !abs.startsWith(repoPath + sep)) {
		throw new Error(`${label} must be a path inside the repository (got "${userRel}")`);
	}
	return abs;
}
