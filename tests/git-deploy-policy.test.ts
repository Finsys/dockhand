/**
 * #1523: the "always redeploy" (forceRedeploy) setting must drive --force-recreate,
 * not just whether we deploy. Previously forceRecreate was computed from the git-diff
 * flag alone, so the setting was read and discarded and the container never re-received
 * its shell-env secrets on a config-only change.
 */

import { describe, test, expect } from 'bun:test';
import { shouldDeployGitStack, shouldForceRecreateGitStack, isDeployFailure, DEPLOY_FAILURE_PREFIX } from '../src/lib/server/git-deploy-policy';

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
	test('retries after a deploy that failed, with no git change of its own', () => {
		// The commit is recorded before the deploy runs, so a failed deploy leaves git
		// reporting no change. Without this the stack is skipped forever on the old
		// version while it reports being in sync.
		expect(
			shouldDeployGitStack({ force: false, forceRedeploy: false, gitUpdated: false, lastDeployFailed: true })
		).toBe(true);
	});
	test('a succeeded last sync does not deploy on its own', () => {
		expect(
			shouldDeployGitStack({ force: false, forceRedeploy: false, gitUpdated: false, lastDeployFailed: false })
		).toBe(false);
	});
	test('omitting the flag behaves as it did before it existed', () => {
		expect(shouldDeployGitStack({ force: false, forceRedeploy: false, gitUpdated: false })).toBe(false);
		expect(shouldDeployGitStack({ force: false, forceRedeploy: false, gitUpdated: true })).toBe(true);
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
	test('a retry recreates, so the containers are not left out of step with the commit', () => {
		// git reports no change on a retry, so a plain up would no-op against the
		// containers the failed deploy never replaced.
		expect(
			shouldForceRecreateGitStack({ forceRedeploy: false, gitUpdated: false, lastDeployFailed: true })
		).toBe(true);
	});
	test('a succeeded last sync does not recreate on its own', () => {
		expect(
			shouldForceRecreateGitStack({ forceRedeploy: false, gitUpdated: false, lastDeployFailed: false })
		).toBe(false);
	});
});

describe('isDeployFailure', () => {
	// syncStatus 'error' has three writers; only a failed deploy leaves the
	// containers out of step with the recorded commit, and only it may retry.
	test('a deploy failure is recognised', () => {
		expect(isDeployFailure('error', `${DEPLOY_FAILURE_PREFIX}no such image`)).toBe(true);
	});

	test('a failed clone is NOT a deploy failure', () => {
		// Nothing was deployed, so the stack must not be redeployed or recreated.
		expect(isDeployFailure('error', 'Git clone failed: Permission denied (publickey)')).toBe(false);
	});

	test('a healthy stack is not a deploy failure whatever the stored text', () => {
		expect(isDeployFailure('synced', null)).toBe(false);
		expect(isDeployFailure('synced', `${DEPLOY_FAILURE_PREFIX}stale text`)).toBe(false);
		expect(isDeployFailure('pending', null)).toBe(false);
		expect(isDeployFailure(null, null)).toBe(false);
	});

	test('error with no stored reason is not treated as a deploy failure', () => {
		expect(isDeployFailure('error', null)).toBe(false);
		expect(isDeployFailure('error', '')).toBe(false);
		expect(isDeployFailure('error', undefined)).toBe(false);
	});

	test('the prefix must lead, not merely appear', () => {
		expect(isDeployFailure('error', `clone said: ${DEPLOY_FAILURE_PREFIX}x`)).toBe(false);
	});
});
