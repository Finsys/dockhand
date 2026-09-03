/**
 * Guard for the filesystem-browser endpoints (`/api/system/files*`).
 *
 * The file browser lets stacks:edit users browse the host to find/adopt/relocate
 * stacks, but no caller may read host or Dockhand secrets through it, so the
 * following are always blocked regardless of permission:
 *   - the database directory ($DATA_DIR/db, contains dockhand.db)
 *   - the encryption key file ($DATA_DIR/.encryption_key)
 *   - the deploy-log directory ($DATA_DIR/deploy-logs, see deploy-log-store.ts) —
 *     deploy logs may carry secrets that survived redaction, and the file
 *     browser is open by design, so this directory has to be named here too.
 *   - /proc - /proc/<pid>/environ exposes process env vars, including
 *     DATABASE_URL (Postgres credentials) and ENCRYPTION_KEY. The whole tree is
 *     blocked because /proc/self, /proc/1, etc. all leak the same secrets and
 *     nothing legitimate is browsed there.
 *   - /etc, /root - system account/secret files (/etc/shadow, /etc/passwd, root's
 *     home). Nothing a compose file lives in.
 *   - any path segment named .ssh (private keys / known_hosts) or .git (its
 *     config embeds remote credentials), at any depth. This blocks the credential
 *     files inside a git-repos clone while still letting the working copies be
 *     browsed (deploy verification, adoption).
 *
 * isProtectedPath resolves symlinks (via the nearest existing ancestor) so a
 * symlink pointing into a protected location can't be used to bypass the check.
 */

import { realpathSync } from 'node:fs';
import { resolve, dirname, join, basename, sep } from 'node:path';

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

/**
 * Resolve `p` to an absolute, symlink-free path. If `p` (or part of it) does not
 * exist yet, realpath the deepest existing ancestor and re-append the missing
 * tail - this still defeats a symlinked ancestor.
 */
function safeResolve(p: string): string {
	let current = resolve(p);
	const tail: string[] = [];
	// Walk up until we hit a path that exists, realpath it, then rejoin the tail.
	while (true) {
		try {
			const real = realpathSync(current);
			return tail.length ? join(real, ...tail.reverse()) : real;
		} catch {
			const parent = dirname(current);
			if (parent === current) {
				// Reached the root without an existing ancestor; return as-is.
				return resolve(p);
			}
			tail.push(basename(current));
			current = parent;
		}
	}
}

function isInside(child: string, parent: string): boolean {
	return child === parent || child.startsWith(parent + sep);
}

/**
 * Returns true if `requestedPath` resolves to a location that must never be read
 * through the file browser (Dockhand's DB/key, the deploy-log directory, system
 * secret trees, or any .ssh / .git directory). Symlinks are resolved first so
 * they can't bypass it.
 */
export function isProtectedPath(requestedPath: string): boolean {
	const { dbDir, keyFile, deployLogsDir } = protectedPaths();
	const resolved = safeResolve(requestedPath);

	// Compare against symlink-resolved targets too: the request is resolved, so a
	// protected target that is itself a symlink (e.g. .encryption_key mounted from
	// a secret store, or a symlinked db/ volume) must be resolved as well or the
	// two never match. safeResolve tolerates a not-yet-existing target.
	if (
		resolved === safeResolve(keyFile) ||
		isInside(resolved, safeResolve(dbDir)) ||
		isInside(resolved, safeResolve(deployLogsDir))
	) {
		return true;
	}
	// Match each root both literally and symlink-resolved (e.g. macOS /etc -> /private/etc).
	if (PROTECTED_ROOTS.some((root) => isInside(resolved, root) || isInside(resolved, safeResolve(root)))) {
		return true;
	}
	const segments = resolved.split(sep).filter(Boolean);
	return segments.some((seg) => PROTECTED_SEGMENTS.has(seg));
}
