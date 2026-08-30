/**
 * Guard for the filesystem-browser endpoints (`/api/system/files*`).
 *
 * Dockhand runs in a container, so there is no host filesystem to leak — users
 * are allowed to browse the container freely (they need this to find/adopt
 * external stacks). The only things that must never be readable are Dockhand's
 * own secrets:
 *   - the database directory ($DATA_DIR/db, contains dockhand.db)
 *   - the encryption key file ($DATA_DIR/.encryption_key)
 *   - /proc — /proc/<pid>/environ exposes process env vars, including
 *     DATABASE_URL (Postgres credentials) and ENCRYPTION_KEY. The whole tree is
 *     blocked because /proc/self, /proc/1, etc. all leak the same secrets and
 *     nothing legitimate is browsed there.
 *   - the deploy-log directory ($DATA_DIR/deploy-logs, see deploy-log-store.ts) —
 *     deploy logs may carry secrets that survived redaction, and the file
 *     browser is open by design, so this directory has to be named here too.
 *
 * isProtectedPath resolves symlinks (via the nearest existing ancestor) so a
 * symlink pointing into a protected location can't be used to bypass the check.
 */

import { realpathSync } from 'node:fs';
import { resolve, dirname, join, basename, sep } from 'node:path';

const KEY_FILE_NAME = '.encryption_key';

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
 * tail — this still defeats a symlinked ancestor.
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
 * Returns true if `requestedPath` resolves to Dockhand's DB directory, the
 * encryption-key file, the deploy-log directory, or anywhere under /proc
 * (process env / cmdline leak credentials). Such paths must be hidden from
 * the file browser.
 */
export function isProtectedPath(requestedPath: string): boolean {
	const { dbDir, keyFile, deployLogsDir } = protectedPaths();
	const resolved = safeResolve(requestedPath);
	return (
		isInside(resolved, dbDir) ||
		resolved === keyFile ||
		isInside(resolved, deployLogsDir) ||
		isInside(resolved, '/proc')
	);
}
