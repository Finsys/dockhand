/**
 * #1523: the "always redeploy" (forceRedeploy) setting must drive --force-recreate,
 * not just whether we deploy. Previously forceRecreate was computed from the git-diff
 * flag alone, so the setting was read and discarded and the container never re-received
 * its shell-env secrets on a config-only change.
 */

import { describe, test, expect } from 'bun:test';
import { shouldDeployGitStack, shouldForceRecreateGitStack } from '../src/lib/server/git-deploy-policy';

describe('shouldDeployGitStack', () => {
	test('deploys on a real git change', () => {
		expect(shouldDeployGitStack({ force: false, forceRedeploy: false, gitUpdated: true })).toBe(true);
	});
	test('deploys on a manual/forced deploy', () => {
		expect(shouldDeployGitStack({ force: true, forceRedeploy: false, gitUpdated: false })).toBe(true);
	});
	test('deploys when forceRedeploy is on even with no git change', () => {
		expect(shouldDeployGitStack({ force: false, forceRedeploy: true, gitUpdated: false })).toBe(true);
	});
	test('skips when nothing changed and nothing forced', () => {
		expect(shouldDeployGitStack({ force: false, forceRedeploy: false, gitUpdated: false })).toBe(false);
	});
});

describe('shouldForceRecreateGitStack', () => {
	test('recreates on a real git change', () => {
		expect(shouldForceRecreateGitStack({ forceRedeploy: false, gitUpdated: true })).toBe(true);
	});
	test('#1523: recreates when forceRedeploy is on even with NO git change', () => {
		// The core bug: this was false before the fix, so the container never recreated
		// and the shell-env secrets were never re-injected.
		expect(shouldForceRecreateGitStack({ forceRedeploy: true, gitUpdated: false })).toBe(true);
	});
	test('recreates when both are set', () => {
		expect(shouldForceRecreateGitStack({ forceRedeploy: true, gitUpdated: true })).toBe(true);
	});
	test('default (setting off, no git change) does NOT recreate - no surprise recreates', () => {
		expect(shouldForceRecreateGitStack({ forceRedeploy: false, gitUpdated: false })).toBe(false);
	});
});
