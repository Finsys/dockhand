import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createStackModel } from '../src/lib/utils/git-model-routing';

describe('create-stack model stamping (createStackModel)', () => {
	it('stamps new stacks from the global default', () => {
		assert.equal(createStackModel('centralized'), 'centralized');
		assert.equal(createStackModel('stack'), 'stack');
	});

	it('ignores any client-supplied model — there is no per-stack chooser', () => {
		assert.equal(createStackModel('stack', 'centralized'), 'stack');
		assert.equal(createStackModel('centralized', 'stack'), 'centralized');
		assert.equal(createStackModel('centralized', undefined), 'centralized');
		assert.equal(createStackModel('centralized', { engine: 'stack' }), 'centralized');
	});
});
