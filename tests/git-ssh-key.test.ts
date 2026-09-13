/**
 * Per-operation SSH key path handling (#1413): concurrent syncs of the same
 * credential must not share one key file, and cleaning up one must never delete
 * another operation's key mid-clone.
 */
import { describe, it, expect } from 'bun:test';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import {
	GIT_SSH_KEY_PATH_ENV,
	makeSshKeyPath,
	resolveSshKeyPathForCleanup,
	removeSshKey
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
