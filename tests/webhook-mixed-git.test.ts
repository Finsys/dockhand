import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stackWebhookContract } from '../src/lib/utils/git-model-routing';

describe('mixed-mode webhook contract (stackWebhookContract)', () => {
	it('stack-model webhook is synchronous with no force-redeploy precondition', () => {
		const contract = stackWebhookContract('stack');
		assert.equal(contract.synchronous, true);
		assert.equal(contract.deprecated, false);
		assert.equal(contract.requiresForceRedeploy, false);
	});

	it('centralized-model stack webhook is the deprecated background shim gated on force-redeploy', () => {
		const contract = stackWebhookContract('centralized');
		assert.equal(contract.synchronous, false);
		assert.equal(contract.deprecated, true);
		assert.equal(contract.requiresForceRedeploy, true);
	});
});
