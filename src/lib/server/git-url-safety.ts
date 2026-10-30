/**
 * Deny-list validation for user-supplied git repo URLs and refs, kept in its OWN
 * import-light module (no db/sqlite) so it is unit-testable. git.ts re-exports and
 * calls these before any git subprocess.
 *
 * These reject inputs that git would execute as a command / read as a local file /
 * parse as an OPTION. Every legitimate scheme (https, http, ssh, git, scp-like
 * git@host:path) passes unchanged, so this is fully backward-compatible.
 */

import { resolve, sep, join, dirname } from 'node:path';
import { isForbiddenStackPath } from './fs-guard';

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

/**
 * Strip credentials embedded in a repo URL for a password/token credential.
 * A password/token in the URL leaks via /proc/<pid>/cmdline, so HTTPS creds are
 * injected via GIT_CONFIG_COUNT env vars elsewhere and dropped from the URL here.
 * On SSH the username (ssh://user@host) is NOT a secret - it is who git logs in
 * as, and the key/password is passed separately - so dropping it makes ssh fall
 * back to the default user (root) and auth fails. Keep the username on SSH; drop
 * only the password. authType other than 'password', or a scp-like git@host URL,
 * is returned unchanged.
 */
export function stripUrlCredentials(url: string, authType: string | null | undefined): string {
	if (authType !== 'password' || url.startsWith('git@')) return url;
	try {
		const parsed = new URL(url);
		const isSsh = parsed.protocol === 'ssh:';
		if (!isSsh) parsed.username = '';
		parsed.password = '';
		return parsed.toString();
	} catch {
		return url;
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
 * blocks any real escape (`/../x` -> `../x` -> refused). A repository can also commit a
 * symlink that points out (`root -> /`), so a path whose links lead to Dockhand's own
 * secrets or /proc is refused as well. `label` names the field for the error message.
 */
export function repoFilePath(repoPath: string, userRel: string, label: string): string {
	const rel = userRel.replace(/^\/+/, '');
	const abs = resolve(repoPath, rel);
	if (abs !== repoPath && !abs.startsWith(repoPath + sep)) {
		throw new Error(`${label} must be a path inside the repository (got "${userRel}")`);
	}
	assertNotForbidden(abs, label, userRel);
	return abs;
}

/** Throws when a path, its symlinks followed, reaches a location stacks may never use. */
function assertNotForbidden(abs: string, label: string, shown: string): void {
	if (isForbiddenStackPath(abs)) {
		throw new Error(`${label} "${shown}" leads to a location that is not allowed`);
	}
}

/**
 * Absolute path of the base `.env` that sits beside a compose file inside a clone. The
 * compose path is resolved through repoFilePath (containment-checked, ABSOLUTE), so the
 * `.env` is just its sibling - NOT re-joined onto repoPath, which would double the prefix
 * (#1495).
 */
export function repoBaseEnvPath(repoPath: string, composeUserPath: string): string {
	const safeComposePath = repoFilePath(repoPath, composeUserPath, 'Compose path');
	const envPath = join(dirname(safeComposePath), '.env');
	assertNotForbidden(envPath, 'Env file', '.env');
	return envPath;
}
