/**
 * The shell/user selection contract shared by the full terminal page and the
 * inspect-modal terminal (both drive ShellUserPicker, which reads these).
 *
 * getBestShell is what auto-selects a usable shell when the saved preference is
 * absent from a container; the user-storage round-trip is what makes a chosen
 * user survive a reload, and a custom user appear in the picker.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// shell-detection.ts imports appendEnvParam from the environment store, which pulls
// in the SvelteKit `$app/environment` alias that bun cannot resolve. Only detectShells
// (the fetch helper, not tested here) uses it, so stub the store. paraglide messages
// are likewise only reached through USER_OPTIONS getters we do not render here.
mock.module('$lib/stores/environment', () => ({
	appendEnvParam: (path: string) => path
}));
mock.module('$lib/paraglide/messages.js', () => ({ m: new Proxy({}, { get: () => () => '' }) }));

// A Map-backed localStorage + a window global, so the browser-gated helpers run
// under bun. Installed before importing the module (it reads window at call time,
// not import time, so order is not strictly required, but keep it honest).
class MemStorage {
	private m = new Map<string, string>();
	getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
	setItem(k: string, v: string) { this.m.set(k, String(v)); }
	removeItem(k: string) { this.m.delete(k); }
	clear() { this.m.clear(); }
}

beforeEach(() => {
	(globalThis as any).window = {};
	(globalThis as any).localStorage = new MemStorage();
});
afterEach(() => {
	delete (globalThis as any).window;
	delete (globalThis as any).localStorage;
});

const {
	getBestShell,
	hasAvailableShell,
	getSavedUser,
	saveUserForContainer,
	getCustomUsers,
	removeCustomUser,
	userForContainerSwitch
} = await import('../src/lib/utils/shell-detection');

type Result = Parameters<typeof getBestShell>[0];
const result = (shells: string[], defaultShell: string | null = null): Result => ({
	shells,
	defaultShell,
	allShells: []
});

describe('getBestShell', () => {
	test('keeps the preferred shell when it is available', () => {
		expect(getBestShell(result(['/bin/bash', '/bin/sh']), '/bin/bash')).toBe('/bin/bash');
	});

	test('matches the preference by basename when the path differs (#1189)', () => {
		// bash resolved to a non-standard path - a /bin/bash preference must still find it.
		expect(getBestShell(result(['/usr/bin/bash', '/bin/sh']), '/bin/bash')).toBe('/usr/bin/bash');
	});

	test('falls back to the detected default when the preference is absent', () => {
		expect(getBestShell(result(['/bin/sh'], '/bin/sh'), '/bin/bash')).toBe('/bin/sh');
	});

	test('returns the default (null) when nothing matches and there is no default', () => {
		expect(getBestShell(result(['/bin/sh'], null), '/bin/zsh')).toBeNull();
	});

	test('an exact match wins over a basename match', () => {
		// Both /bin/bash and /usr/local/bin/bash are present; the exact path is kept.
		expect(getBestShell(result(['/usr/local/bin/bash', '/bin/bash']), '/bin/bash')).toBe('/bin/bash');
	});
});

describe('hasAvailableShell', () => {
	test('true when at least one shell was detected', () => {
		expect(hasAvailableShell(result(['/bin/sh']))).toBe(true);
	});
	test('false when none were detected', () => {
		expect(hasAvailableShell(result([]))).toBe(false);
	});
});

describe('user storage round-trip', () => {
	test('a non-root user is saved and read back for that container', () => {
		saveUserForContainer('c1', 'node');
		expect(getSavedUser('c1')).toBe('node');
	});

	test('a different container keeps its own user', () => {
		saveUserForContainer('c1', 'node');
		saveUserForContainer('c2', 'postgres');
		expect(getSavedUser('c1')).toBe('node');
		expect(getSavedUser('c2')).toBe('postgres');
	});

	test('root is the default and is not persisted (null means root)', () => {
		saveUserForContainer('c1', 'node');
		saveUserForContainer('c1', 'root');
		// root clears the entry, so a fresh read returns null (the caller treats null as root)
		expect(getSavedUser('c1')).toBeNull();
	});

	test('an unknown container has no saved user', () => {
		expect(getSavedUser('never-seen')).toBeNull();
	});

	test('a non-preset user is also tracked in the global custom-user list', () => {
		saveUserForContainer('c1', 'node');
		expect(getCustomUsers()).toContain('node');
	});

	test('a preset user (nobody) is NOT added to the custom list', () => {
		saveUserForContainer('c1', 'nobody');
		expect(getCustomUsers()).not.toContain('nobody');
	});

	test('removeCustomUser drops it from the list and clears containers using it', () => {
		saveUserForContainer('c1', 'node');
		saveUserForContainer('c2', 'node');
		removeCustomUser('node');
		expect(getCustomUsers()).not.toContain('node');
		expect(getSavedUser('c1')).toBeNull();
		expect(getSavedUser('c2')).toBeNull();
	});
});

describe('userForContainerSwitch', () => {
	test('a saved user is restored on switch', () => {
		expect(userForContainerSwitch('node', 'root')).toBe('node');
	});
	test('no saved user falls back to root, never the previous user (the leak this guards)', () => {
		// Previous container left user='node'; switching to one with no saved user must
		// NOT carry 'node' over.
		expect(userForContainerSwitch(null, 'node')).toBe('root');
	});
	test('no saved user keeps root when already root', () => {
		expect(userForContainerSwitch(null, 'root')).toBe('root');
	});
});
