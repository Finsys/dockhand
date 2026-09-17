import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	mergeDeployGitStackOpts,
	repoFanOutDefersStack,
	shouldDeployGitStack
} from '../src/lib/utils/git-deploy-gating';

describe('shouldDeployGitStack', () => {
	const base = {
		force: false,
		ignoreForceRedeploy: false,
		forceRedeploy: false,
		updated: false
	};

	it('skips when nothing changed and no force/redeploy flag is set', () => {
		assert.equal(shouldDeployGitStack(base), false);
	});

	it('deploys when the sync found changes', () => {
		assert.equal(shouldDeployGitStack({ ...base, updated: true }), true);
	});

	it('always deploys when force is set, even with no changes', () => {
		assert.equal(shouldDeployGitStack({ ...base, force: true }), true);
	});

	it('deploys when forceRedeploy is set and no caller ignores it', () => {
		assert.equal(shouldDeployGitStack({ ...base, forceRedeploy: true }), true);
	});

	it('suppresses forceRedeploy when every caller opted into ignoreForceRedeploy', () => {
		const result = shouldDeployGitStack({
			...base,
			forceRedeploy: true,
			ignoreForceRedeploy: true
		});
		assert.equal(result, false);
	});

	it('still deploys changed stacks even when forceRedeploy is ignored', () => {
		assert.equal(
			shouldDeployGitStack({ ...base, ignoreForceRedeploy: true, updated: true }),
			true
		);
	});

	it('treats an undefined updated flag as falsy', () => {
		assert.equal(shouldDeployGitStack({ ...base, updated: undefined }), false);
	});
});

describe('mergeDeployGitStackOpts', () => {
	it('keeps the weaker intent when both callers agree', () => {
		assert.deepEqual(
			mergeDeployGitStackOpts(
				{ force: false, ignoreForceRedeploy: false },
				{ force: false, ignoreForceRedeploy: false }
			),
			{ force: false, ignoreForceRedeploy: false }
		);
	});

	it('merges force with OR so any caller forcing wins', () => {
		assert.deepEqual(
			mergeDeployGitStackOpts(
				{ force: true, ignoreForceRedeploy: false },
				{ force: false, ignoreForceRedeploy: false }
			),
			{ force: true, ignoreForceRedeploy: false }
		);
	});

	it('merges ignoreForceRedeploy with AND so a single non-ignoring caller wins', () => {
		assert.deepEqual(
			mergeDeployGitStackOpts(
				{ force: false, ignoreForceRedeploy: true },
				{ force: false, ignoreForceRedeploy: false }
			),
			{ force: false, ignoreForceRedeploy: false }
		);
	});

	it('preserves forceRedeploy honoring when all callers ignore it', () => {
		assert.deepEqual(
			mergeDeployGitStackOpts(
				{ force: false, ignoreForceRedeploy: true },
				{ force: false, ignoreForceRedeploy: true }
			),
			{ force: false, ignoreForceRedeploy: true }
		);
	});
});

describe('repoFanOutDefersStack', () => {
	it('defers only stacks with forceRedeploy AND a stack-level webhook', () => {
		assert.equal(repoFanOutDefersStack({ forceRedeploy: true, webhookEnabled: true }), true);
		assert.equal(repoFanOutDefersStack({ forceRedeploy: true, webhookEnabled: false }), false);
		assert.equal(repoFanOutDefersStack({ forceRedeploy: false, webhookEnabled: true }), false);
		assert.equal(repoFanOutDefersStack({ forceRedeploy: false, webhookEnabled: false }), false);
	});
});
