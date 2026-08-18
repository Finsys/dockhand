import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldDeployGitStack } from '../src/lib/utils/git-deploy-gating';

/**
 * Stack engine deploy gating (git-stack.ts) is exactly
 * shouldDeployGitStack with ignoreForceRedeploy=false:
 *   force || forceRedeploy || updated
 * These assertions pin that contract so the sealed engine cannot drift.
 */
describe('stack engine deploy gating', () => {
	it('deploys when forced', () => {
		assert.equal(shouldDeployGitStack({ force: true, ignoreForceRedeploy: false, forceRedeploy: false, updated: false }), true);
	});

	it('deploys when forceRedeploy is set even without changes', () => {
		assert.equal(shouldDeployGitStack({ force: false, ignoreForceRedeploy: false, forceRedeploy: true, updated: false }), true);
	});

	it('deploys when there are changes', () => {
		assert.equal(shouldDeployGitStack({ force: false, ignoreForceRedeploy: false, forceRedeploy: false, updated: true }), true);
	});

	it('skips when nothing changed and nothing forces', () => {
		assert.equal(shouldDeployGitStack({ force: false, ignoreForceRedeploy: false, forceRedeploy: false, updated: false }), false);
	});

	it('ignoreForceRedeploy only suppresses forceRedeploy (centralized webhook-vs-fanout race)', () => {
		// Centralized stack-webhook-vs-repo-fanout semantics — distinct from the stack engine.
		assert.equal(shouldDeployGitStack({ force: false, ignoreForceRedeploy: true, forceRedeploy: true, updated: false }), false);
		assert.equal(shouldDeployGitStack({ force: false, ignoreForceRedeploy: false, forceRedeploy: true, updated: false }), true);
	});
});
