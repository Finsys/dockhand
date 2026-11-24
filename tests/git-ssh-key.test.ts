/**
 * Per-operation SSH key path handling (#1413): concurrent syncs of the same
 * credential must not share one key file, and cleaning up one must never delete
 * another operation's key mid-clone.
 */
import { describe, it, expect } from 'bun:test';
import { existsSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	GIT_SSH_KEY_PATH_ENV,
	makeSshKeyPath,
	resolveSshKeyPathForCleanup,
	removeSshKey,
	cleanupSshKey
} from '../src/lib/server/git-ssh-key';

describe('git ssh key paths (#1413)', () => {
	it('each operation gets a UNIQUE path, even for the same credential id', () => {
		const paths = new Set(Array.from({ length: 50 }, () => makeSshKeyPath(1)));
		expect(paths.size).toBe(50); // no collisions across concurrent ops of credential 1
		for (const p of paths) expect(p.startsWith('/tmp/.ssh-key-1-')).toBe(true);
	});

	it('cleanup targets the exact path stashed in env, not a shared per-credential path', () => {
		const opPath = makeSshKeyPath(7);
		expect(resolveSshKeyPathForCleanup(7, { [GIT_SSH_KEY_PATH_ENV]: opPath })).toBe(opPath);
	});

	it('falls back to the legacy deterministic path only when no env is given', () => {
		expect(resolveSshKeyPathForCleanup(7)).toBe('/tmp/.ssh-key-7');
		expect(resolveSshKeyPathForCleanup(7, {})).toBe('/tmp/.ssh-key-7');
	});

	it('removing one operation key leaves a concurrent operation key intact (the race)', () => {
		const a = makeSshKeyPath(3);
		const b = makeSshKeyPath(3);
		expect(a).not.toBe(b);
		writeFileSync(a, 'KEY-A');
		writeFileSync(b, 'KEY-B');
		try {
			// Operation A finishes and cleans up its key...
			removeSshKey(3, { [GIT_SSH_KEY_PATH_ENV]: a });
			expect(existsSync(a)).toBe(false);
			// ...while operation B is still cloning: its key MUST survive.
			expect(existsSync(b)).toBe(true);
		} finally {
			for (const p of [a, b]) { try { rmSync(p); } catch { /* ignore */ } }
		}
	});

	it('removeSshKey is a no-op (no throw) when the file is already gone', () => {
		expect(() => removeSshKey(99, { [GIT_SSH_KEY_PATH_ENV]: makeSshKeyPath(99) })).not.toThrow();
	});
});

// cleanupSshKey is what every git operation's finally calls. The per-call key file must
// be deleted when the op ends; passing env is what makes cleanup hit the real path
// instead of the stale legacy one. A caller that drops env leaves the decrypted,
// passphrase-free key on disk, readable through the file browser.
describe('cleanupSshKey (operation finally-block cleanup)', () => {
	it('deletes the exact per-op key when the op env is passed', () => {
		const keyPath = makeSshKeyPath(11);
		writeFileSync(keyPath, '-----BEGIN OPENSSH PRIVATE KEY-----');
		try {
			cleanupSshKey({ id: 11, authType: 'ssh' }, { [GIT_SSH_KEY_PATH_ENV]: keyPath });
			expect(existsSync(keyPath)).toBe(false);
		} finally {
			try { rmSync(keyPath); } catch { /* ignore */ }
		}
	});

	it('WITHOUT env it misses the per-op key (the leak a dropped env arg reintroduces)', () => {
		// Pins why env matters: no env -> legacy deterministic path -> the real
		// makeSshKeyPath file survives. This is the exact regression of a call site
		// reverting cleanupSshKey(credential, env) to cleanupSshKey(credential).
		const keyPath = makeSshKeyPath(12);
		writeFileSync(keyPath, 'KEY');
		try {
			cleanupSshKey({ id: 12, authType: 'ssh' }); // no env
			expect(existsSync(keyPath)).toBe(true); // leaked
		} finally {
			try { rmSync(keyPath); } catch { /* ignore */ }
		}
	});

	it('does nothing for a non-ssh credential or null', () => {
		const keyPath = makeSshKeyPath(13);
		writeFileSync(keyPath, 'KEY');
		try {
			cleanupSshKey({ id: 13, authType: 'password' }, { [GIT_SSH_KEY_PATH_ENV]: keyPath });
			expect(existsSync(keyPath)).toBe(true); // untouched: not an ssh cred
			cleanupSshKey(null, { [GIT_SSH_KEY_PATH_ENV]: keyPath });
			expect(existsSync(keyPath)).toBe(true);
		} finally {
			try { rmSync(keyPath); } catch { /* ignore */ }
		}
	});

	// git.ts imports db, so the call sites cannot be imported and run under bun. The
	// behaviour above proves cleanupSshKey needs env; this source-level check pins that
	// every call site actually forwards it (a dropped env arg is the exact leak). A
	// rename/reformat that keeps the semantics but drops a bare cleanupSshKey(x) call is
	// what this guards.
	it('every git.ts cleanupSshKey call site passes env', () => {
		const src = readFileSync(join(process.cwd(), 'src', 'lib', 'server', 'git.ts'), 'utf8');
		const calls = src.match(/cleanupSshKey\([^)]*\)/g) ?? [];
		expect(calls.length).toBeGreaterThan(0);
		// Every call must pass a second argument (env). A single-arg call is the bug.
		const singleArg = calls.filter((c) => !c.includes(','));
		expect(singleArg).toEqual([]);
	});
});
