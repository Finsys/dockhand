import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateEnvName, RESERVED_ENV_NAMES, RESERVED_ENV_NAME_RE } from '../src/lib/utils/env-name';

describe('env-name reservations (git-repos layout)', () => {
	it('allows normal environment names', () => {
		for (const name of ['production', 'staging', 'rambo (ARM)', 'docker-websites', 'dev-01']) {
			assert.equal(validateEnvName(name).ok, true, `expected "${name}" to be valid`);
		}
	});

	it('rejects the reserved "shared" namespace', () => {
		assert.equal(RESERVED_ENV_NAMES.has('shared'), true);
		const result = validateEnvName('shared');
		assert.equal(result.ok, false);
		assert.match(result.reason ?? '', /reserved/);
	});

	it('rejects "stack-<n>" fallback-clone names', () => {
		assert.match('stack-12', RESERVED_ENV_NAME_RE);
		assert.equal(validateEnvName('stack-12').ok, false);
		assert.equal(validateEnvName('stack-0').ok, false);
	});

	it('still rejects the pre-existing shell-special characters', () => {
		for (const name of ['a/b', 'b*a', ' leading', 'trailing ', 'a;rm']) {
			assert.equal(validateEnvName(name).ok, false, `expected "${name}" to be invalid`);
		}
	});
});
