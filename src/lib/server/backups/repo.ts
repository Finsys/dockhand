/**
 * backups/repo.ts — repository lifecycle operations that talk only to the restic
 * repo (no container volumes): initialise, check integrity, prune, unlock, and a
 * reachability test. Each is a thin, explicit wrapper over the injected Restic
 * runner that turns restic's exit code + output into a structured result.
 *
 * These are repo-only, so they use `runLocal` (restic on the host). The Restic
 * runner is injected so this module is testable without a real repo.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'path';
import { BackupError, type ResticRun } from './models';
import { cleanErrorMsg, timingSafeStrEqual } from './security';

/** The restic surface repo.ts needs (injected). */
export interface ResticLocal {
	runLocal(destination: any, args: string[], tier?: 'interactive' | 'data'): Promise<ResticRun>;
}

/** A repo operation result: ok + human output, or a classified failure. */
export type RepoResult =
	| { ok: true; output: string }
	| { ok: false; code: BackupError['code']; error: string };

/** restic exit 10 = repository not initialised / not found. */
const EXIT_NOT_INITIALIZED = 10;

/** Classify a failed restic run into a stable error code + message. */
export function classifyRepoFailure(run: ResticRun): { code: BackupError['code']; error: string } {
	const text = (run.stderr + '\n' + run.stdout).toLowerCase();
	if (run.exitCode === EXIT_NOT_INITIALIZED || text.includes('is not a restic repository') || text.includes('unable to open config')) {
		return { code: 'REPO_NOT_INITIALIZED', error: 'repository is not initialised' };
	}
	if (text.includes('wrong password') || text.includes('bad password') || text.includes('decrypt')) {
		return { code: 'WRONG_PASSWORD', error: 'wrong repository password' };
	}
	if (text.includes('repository is already locked') || text.includes('unable to create lock')) {
		return { code: 'REPO_LOCKED', error: 'repository is locked by another operation' };
	}
	if (run.exitCode === undefined) {
		return { code: 'RESTIC', error: 'restic did not complete (unknown outcome)' };
	}
	return { code: 'RESTIC', error: run.stderr.trim() || run.stdout.trim() || `restic exited ${run.exitCode}` };
}

function toResult(run: ResticRun): RepoResult {
	if (run.exitCode === 0) return { ok: true, output: (run.stdout.trim() || run.stderr.trim() || 'ok') };
	return { ok: false, ...classifyRepoFailure(run) };
}

/** Initialise a repository. Succeeds if init works OR the repo already exists. */
export async function initRepository(restic: ResticLocal, destination: any): Promise<RepoResult> {
	const run = await restic.runLocal(destination, ['init']);
	if (run.exitCode === 0) return { ok: true, output: 'repository initialised' };
	// Already-initialised is a success for our purposes.
	if ((run.stderr + run.stdout).toLowerCase().includes('already initialized') ||
		(run.stderr + run.stdout).toLowerCase().includes('already exists')) {
		return { ok: true, output: 'repository already initialised' };
	}
	return { ok: false, ...classifyRepoFailure(run) };
}

/** Test that a repository is reachable + the password is correct (cheap read). */
export async function testRepository(restic: ResticLocal, destination: any): Promise<RepoResult> {
	const run = await restic.runLocal(destination, ['cat', 'config', '--no-lock']);
	return toResult(run);
}

/** Integrity check. `readDataSubset` (e.g. '5%') re-reads pack data to prove
 * restorability; omit for a structure-only check. Runs on the long timeout tier
 * because a data check on a large cloud repo far exceeds the interactive limit. */
export async function checkRepository(restic: ResticLocal, destination: any, readDataSubset?: string): Promise<RepoResult> {
	const args = ['check', '--no-lock'];
	if (readDataSubset) args.push('--read-data-subset', readDataSubset);
	const run = await restic.runLocal(destination, args, 'data');
	return toResult(run);
}

/** Prune the repository (reclaim unreferenced data). Long timeout tier. */
export async function pruneRepository(restic: ResticLocal, destination: any, maxUnused?: string): Promise<RepoResult> {
	const args = ['prune', '--retry-lock', '5m'];
	if (maxUnused) args.push('--max-unused', maxUnused);
	const run = await restic.runLocal(destination, args, 'data');
	return toResult(run);
}

/** Remove stale repository locks left by a crashed operation. */
export async function unlockRepository(restic: ResticLocal, destination: any): Promise<RepoResult> {
	// `--remove-all`, not a plain `unlock`. This is an EXPLICIT, user-initiated action
	// ("Unlock" in the UI / `task:unlock`), whose documented purpose is to "remove stale
	// locks left behind when a previous restic operation crashed or was killed" and is
	// "safe if no other operation is currently running against the repo". A plain
	// `restic unlock` only removes locks it can prove stale, and it CANNOT prove that for
	// a lock whose hostname belongs to a now-gone helper CONTAINER (restic:
	// `if hn != l.Hostname { return false }`, then a 30-min age-out) — i.e. exactly the
	// orphaned lock this button exists to clear. So the plain form silently failed to do
	// what the UI/manual promise. `--remove-all` makes it actually clear those locks.
	// Only reachable via a deliberate user/API call, never automatic retention.
	const run = await restic.runLocal(destination, ['unlock', '--remove-all']);
	return toResult(run);
}

/** Repository statistics (size, file count, snapshot count). */
export async function repoStats(restic: ResticLocal, destination: any): Promise<RepoResult> {
	const run = await restic.runLocal(destination, ['stats', '--no-lock', '--json']);
	return toResult(run);
}

// =============================================================================
// Repository password rotation
// =============================================================================

/** The result of a password rotation. `dbOutOfSync` is the critical case: restic
 * accepted the new password (the old key is gone) but persisting it to our DB
 * failed, so the repo now expects a password Dockhand no longer knows. */
export type RotateResult =
	| { ok: true }
	| { ok: false; error: string; dbOutOfSync?: boolean };

/** A decrypted destination — carries the plaintext current password for the
 * constant-time pre-check. */
interface DecryptedDestination {
	id: number;
	decryptedPassword: string;
}

/** The persistence + serialization surface rotation needs (injected). Kept out of
 * this pure module so it stays testable without a DB or a real repo. */
export interface RotatePorts {
	restic: ResticLocal;
	/** Load + decrypt the destination (plaintext current password), or null. */
	getDecryptedDestination(id: number): Promise<DecryptedDestination | null>;
	/** Persist the new password to the destination row. Throws on failure. */
	updatePassword(id: number, newPassword: string): Promise<void>;
	/** Serialize the key change against any other operation on this destination
	 * (a concurrent backup/prune with the stale key would fail mid-rotation). */
	serializeDestination<T>(id: number, fn: () => Promise<T>): Promise<T>;
}

/**
 * Rotate a destination's restic repository password.
 *
 * Order matters:
 *  1. Reject a weak or unchanged new password before doing anything.
 *  2. Constant-time compare the supplied current password against the stored one,
 *     so response timing can't leak how much of a guess is right.
 *  3. Run `restic key passwd` with the new password in a 0600 tmpfile — never on
 *     argv, which leaks via /proc/<pid>/cmdline. The tmpfile is shredded on every
 *     exit path. The key change is serialized on the destination.
 *  4. Persist the new password. If restic already swapped the key (step 3
 *     succeeded) but this write fails, the repo expects the new password and the
 *     DB still holds the old one — a critical out-of-sync state we flag distinctly
 *     so the caller can prompt the operator to fix it.
 */
export async function rotateDestinationPassword(
	ports: RotatePorts,
	destinationId: number,
	currentPassword: string,
	newPassword: string,
): Promise<RotateResult> {
	if (!newPassword || newPassword.length < 8) {
		return { ok: false, error: 'New password must be at least 8 characters' };
	}
	if (currentPassword === newPassword) {
		return { ok: false, error: 'New password must differ from current password' };
	}

	const destination = await ports.getDecryptedDestination(destinationId);
	if (!destination) return { ok: false, error: 'Destination not found' };

	if (!timingSafeStrEqual(destination.decryptedPassword, currentPassword)) {
		return { ok: false, error: 'Current password does not match' };
	}

	const { writeFileSync, unlinkSync } = await import('fs');
	const { tmpdir } = await import('os');
	const newPwFile = join(tmpdir(), `dockhand-restic-newpw-${randomUUID()}`);
	writeFileSync(newPwFile, newPassword, { mode: 0o600 });

	let run: ResticRun;
	try {
		run = await ports.serializeDestination(destinationId, () =>
			ports.restic.runLocal(destination as any, ['key', 'passwd', '--new-password-file', newPwFile]),
		);
	} finally {
		// Always shred the 0600 password tmpfile, on every exit path.
		try { unlinkSync(newPwFile); } catch { /* already gone */ }
	}

	if (run.exitCode !== 0) {
		return { ok: false, error: cleanErrorMsg(run.stderr.trim() || run.stdout.trim() || 'restic key change failed') };
	}

	// restic accepted the new password and removed the old key. From now on the
	// repo only accepts newPassword — persist it immediately.
	try {
		await ports.updatePassword(destinationId, newPassword);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			dbOutOfSync: true,
			error: `Repository password was rotated but Dockhand could not persist the new password to its database. Manually update the destination password to the new value to restore access. (${msg})`,
		};
	}

	return { ok: true };
}
