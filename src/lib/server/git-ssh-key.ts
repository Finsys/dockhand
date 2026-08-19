/**
 * Per-operation temporary SSH key path handling for Git operations (#1413).
 *
 * Concurrent syncs of the SAME credential must NOT share one key file: a
 * per-credential path (`/tmp/.ssh-key-<id>`) lets one operation's cleanup delete
 * the key while another operation is still cloning with it, which fails as
 * "Identity file /tmp/.ssh-key-<id> not accessible". Each operation gets a unique
 * path (credential id + pid + uuid); the exact path is remembered so cleanup
 * removes only the file this operation created.
 *
 * Pure + dependency-free so it can be unit-tested without importing the whole
 * git.ts module (which pulls db/stacks/notifications).
 */
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Env key under which git.ts stashes the operation's key path (so cleanup can
// find the exact file even though the caller only has the credential + env).
export const GIT_SSH_KEY_PATH_ENV = 'DOCKHAND_GIT_SSH_KEY_PATH';

/** A unique /tmp path for this operation's SSH key. */
export function makeSshKeyPath(credentialId: number): string {
	return `/tmp/.ssh-key-${credentialId}-${process.pid}-${randomUUID()}`;
}

/**
 * Resolve which key file to delete for cleanup: the exact per-operation path
 * stashed in env, falling back to the legacy deterministic path only when no env
 * is available (legacy callers).
 */
export function resolveSshKeyPathForCleanup(
	credentialId: number,
	env?: Record<string, string>
): string {
	return env?.[GIT_SSH_KEY_PATH_ENV] || `/tmp/.ssh-key-${credentialId}`;
}

/** Remove the SSH key file for an operation, ignoring errors. */
export function removeSshKey(credentialId: number, env?: Record<string, string>): void {
	const path = resolveSshKeyPathForCleanup(credentialId, env);
	try {
		if (existsSync(path)) rmSync(path);
	} catch {
		// Ignore cleanup errors - a leftover /tmp key is harmless.
	}
}
