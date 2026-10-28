/**
 * Guard for the filesystem-browser endpoints (`/api/system/files*`).
 *
 * The file browser lets stacks:edit users browse the host to find/adopt/relocate
 * stacks, but no caller may read host or Dockhand secrets through it, so the
 * following are always blocked regardless of permission:
 *   - the database directory ($DATA_DIR/db, contains dockhand.db)
 *   - the encryption key file ($DATA_DIR/.encryption_key)
 *   - /proc - /proc/<pid>/environ exposes process env vars, including
 *     DATABASE_URL (Postgres credentials) and ENCRYPTION_KEY. The whole tree is
 *     blocked because /proc/self, /proc/1, etc. all leak the same secrets and
 *     nothing legitimate is browsed there.
 *   - /etc, /root - system account/secret files (/etc/shadow, /etc/passwd, root's
 *     home). Nothing a compose file lives in.
 *   - any path segment named .ssh (private keys / known_hosts) or .git (its
 *     config embeds remote credentials), at any depth and in any case, also when
 *     the segment is a symlink. This blocks the credential
 *     files inside a git-repos clone while still letting the working copies be
 *     browsed (deploy verification, adoption).
 *   - the deploy-log directory ($DATA_DIR/deploy-logs, see deploy-log-store.ts) —
 *     deploy logs may carry secrets that survived redaction, and the file
 *     browser is open by design, so this directory has to be named here too.
 *
 * isProtectedPath resolves a path the way the OS opens it (symlinks followed before
 * any `..` after them), so neither a symlink nor `..` can carry a request into a
 * protected location.
 */

import { lstatSync, readlinkSync } from 'node:fs';
import { resolve, dirname, join, sep, isAbsolute } from 'node:path';

const KEY_FILE_NAME = '.encryption_key';

/** Absolute directory subtrees blocked for every caller. */
const PROTECTED_ROOTS = ['/proc', '/etc', '/root'];

/** A path segment named this (at any depth) is blocked: .ssh (keys/known_hosts),
 * .git (its config embeds remote credentials). Blocks the secret files in a
 * git-repos clone without hiding the browsable working copies. */
const PROTECTED_SEGMENTS = new Set(['.ssh', '.git']);

function getDataDir(): string {
	return process.env.DATA_DIR || './data';
}

/** Absolute paths Dockhand must never expose through the file browser. */
function protectedPaths(): { dbDir: string; keyFile: string; deployLogsDir: string } {
	const dataDir = resolve(getDataDir());
	return {
		dbDir: join(dataDir, 'db'),
		keyFile: join(dataDir, KEY_FILE_NAME),
		// deploy logs may contain secrets that survived redaction; the file browser is open by
		// design, so this directory is named here (see deploy-log-store.ts).
		deployLogsDir: join(dataDir, 'deploy-logs')
	};
}

/** Symlinks followed while resolving one path before giving up, as the OS does (ELOOP). */
const MAX_LINKS = 40;

function isProtectedSegment(name: string): boolean {
	return PROTECTED_SEGMENTS.has(name.toLowerCase());
}

/**
 * Resolve `p` to the absolute, symlink-free path the OS would open, one component at
 * a time: a symlink is replaced by its target before any `..` after it is applied.
 * Simplifying `..` first (path.resolve, and Node's own realpathSync) would judge
 * `/var/run/../etc` (with /var/run -> /run) as /var/etc while the OS opens /etc.
 * A missing component ends the walk with the rest appended as given.
 *
 * Returns null for a path that must be refused before its end is known: one that
 * passes through /proc (its links, such as fd/N of a deleted file, open something
 * other than what readlink names), through a component named .ssh or .git (also
 * when that component is a symlink), a `..` after a missing component, a component
 * that cannot be inspected, or a symlink loop.
 */
function safeResolve(p: string): string | null {
	const pending = (isAbsolute(p) ? p : process.cwd() + sep + p).split(sep);
	let resolved: string = sep;
	let links = 0;
	while (pending.length) {
		const name = pending.shift()!;
		if (name === '' || name === '.') continue;
		if (name === '..') {
			resolved = dirname(resolved);
			continue;
		}
		if (isProtectedSegment(name)) return null;
		const next = join(resolved, name);
		if (isInside(next, '/proc')) return null;
		let stat;
		try {
			stat = lstatSync(next);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
			const rest = pending.filter((n) => n !== '' && n !== '.');
			return rest.includes('..') ? null : join(next, ...rest);
		}
		if (stat.isSymbolicLink()) {
			if (++links > MAX_LINKS) return null;
			const target = readlinkSync(next);
			if (isAbsolute(target)) resolved = sep;
			pending.unshift(...target.split(sep));
			continue;
		}
		resolved = next;
	}
	return resolved;
}

/** A protected location's own resolution, or its lexical form when it cannot be walked. */
function resolveTarget(p: string): string {
	return safeResolve(p) ?? resolve(p);
}

/** Case-insensitive: on a case-insensitive filesystem `.ENCRYPTION_KEY` opens the key. */
function isInside(child: string, parent: string): boolean {
	const c = child.toLowerCase();
	const p = parent.toLowerCase();
	return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * Returns true if `requestedPath` resolves to a location that must never be read
 * through the file browser (Dockhand's DB/key, the deploy-log directory, system
 * secret trees, or any .ssh / .git directory). Symlinks are resolved first so
 * they can't bypass it.
 */
export function isProtectedPath(requestedPath: string): boolean {
	return judge(requestedPath, PROTECTED_ROOTS);
}

/**
 * The narrower rule for a stack's compose and env paths: Dockhand's own secrets, /proc
 * and any .ssh / .git, but not /etc or /root. Inside Dockhand's container those hold the
 * container's own system files, and stacks are legitimately kept under /root (a host
 * path mounted at the same path in the container).
 */
export function isForbiddenStackPath(requestedPath: string): boolean {
	return judge(requestedPath, STACK_FORBIDDEN_ROOTS);
}

/** Roots refused for stack paths. */
const STACK_FORBIDDEN_ROOTS = ['/proc'];

function judge(requestedPath: string, roots: readonly string[]): boolean {
	const { dbDir, keyFile, deployLogsDir } = protectedPaths();
	const resolved = safeResolve(requestedPath);
	if (resolved === null) return true;

	// Compare against symlink-resolved targets too: the request is resolved, so a
	// protected target that is itself a symlink (e.g. .encryption_key mounted from
	// a secret store, or a symlinked db/ volume) must be resolved as well or the
	// two never match. safeResolve tolerates a not-yet-existing target.
	if (
		isInside(resolved, resolveTarget(keyFile)) ||
		isInside(resolved, resolveTarget(dbDir)) ||
		isInside(resolved, resolveTarget(deployLogsDir))
	) {
		return true;
	}
	// Match each root both literally and symlink-resolved (e.g. macOS /etc -> /private/etc).
	if (roots.some((root) => isInside(resolved, root) || isInside(resolved, resolveTarget(root)))) {
		return true;
	}
	return resolved.split(sep).some(isProtectedSegment);
}

/**
 * True when `dir` is a forbidden stack path or holds one of Dockhand's secrets (or /proc)
 * anywhere below it, so moving the directory's entries would carry one along.
 */
export function holdsForbiddenStackPath(dir: string): boolean {
	if (isForbiddenStackPath(dir)) return true;
	const resolved = safeResolve(dir);
	if (resolved === null) return true;
	const { dbDir, keyFile, deployLogsDir } = protectedPaths();
	return [keyFile, dbDir, deployLogsDir, ...STACK_FORBIDDEN_ROOTS].some(
		(target) => isInside(target, resolved) || isInside(resolveTarget(target), resolved)
	);
}
