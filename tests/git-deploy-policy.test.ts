/**
 * Git-stack deploy decisions. A git change DEPLOYS (shouldDeployGitStack) but does not
 * force a recreate: `docker compose up -d` recreates the services whose config actually
 * changed on its own, so forcing it restarted the whole stack for a change that touched
 * no service (a README). --force-recreate is reserved for the always-redeploy opt-in and
 * a retry after a failed deploy, where a plain `up` would no-op.
 */

import { describe, test, expect } from 'bun:test';
import { shouldDeployGitStack, shouldForceRecreateGitStack, gitDeployDecision, isDeployFailure, DEPLOY_FAILURE_PREFIX } from '../src/lib/server/git-deploy-policy';

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
	test('a git change does NOT force a recreate - compose recreates the changed services itself', () => {
		// A docs-only commit (README in the stack dir) must not restart the stack. Any
		// change that actually affects a service - image, env value, compose field - moves
		// that service's compose config hash, so `up -d` recreates it without --force-recreate.
		expect(shouldForceRecreateGitStack({ forceRedeploy: false })).toBe(false);
	});
	test('the always-redeploy opt-in forces a recreate', () => {
		// An explicit choice to restart regardless of diff; a plain `up` would no-op.
		expect(shouldForceRecreateGitStack({ forceRedeploy: true })).toBe(true);
	});
	test('a retry after a failed deploy recreates, so containers are not left out of step', () => {
		// git reports no change on a retry, so a plain `up` would no-op against the
		// containers the failed deploy never replaced.
		expect(shouldForceRecreateGitStack({ forceRedeploy: false, lastDeployFailed: true })).toBe(true);
	});
	test('a succeeded last sync does not recreate on its own', () => {
		expect(shouldForceRecreateGitStack({ forceRedeploy: false, lastDeployFailed: false })).toBe(false);
	});
});

/**
 * The combined decision the deploy path actually uses. A git change DEPLOYS but must NOT
 * force a recreate - that is the regression this guards (a docs-only commit sets
 * gitUpdated and used to recreate the whole stack). Behavioural, not a source grep: gitUpdated
 * is an INPUT here, and the test proves it moves `deploy` while leaving `forceRecreate` alone.
 */
describe('gitDeployDecision', () => {
	const base = { force: false, forceRedeploy: false, gitUpdated: false, lastDeployFailed: false };

	test('a git change deploys but does NOT force a recreate', () => {
		expect(gitDeployDecision({ ...base, gitUpdated: true })).toEqual({ deploy: true, forceRecreate: false });
	});

	test('gitUpdated changes deploy but never forceRecreate', () => {
		// The near miss: flipping gitUpdated must move deploy and leave forceRecreate fixed.
		const off = gitDeployDecision({ ...base, gitUpdated: false });
		const on = gitDeployDecision({ ...base, gitUpdated: true });
		expect(off.deploy).toBe(false);
		expect(on.deploy).toBe(true);
		expect(off.forceRecreate).toBe(false);
		expect(on.forceRecreate).toBe(false);
	});

	test('forceRedeploy forces a recreate (and deploys)', () => {
		expect(gitDeployDecision({ ...base, forceRedeploy: true })).toEqual({ deploy: true, forceRecreate: true });
	});

	test('a failed-deploy retry forces a recreate', () => {
		expect(gitDeployDecision({ ...base, lastDeployFailed: true })).toEqual({ deploy: true, forceRecreate: true });
	});

	test('a manual deploy (force) deploys without forcing a recreate', () => {
		expect(gitDeployDecision({ ...base, force: true })).toEqual({ deploy: true, forceRecreate: false });
	});

	test('nothing changed: neither deploy nor recreate', () => {
		expect(gitDeployDecision(base)).toEqual({ deploy: false, forceRecreate: false });
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
