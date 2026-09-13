/**
 * injected_secret_keys parse/serialize semantics (H1 masking source of truth).
 *
 * The masking set for provider-injected secrets is whatever names were persisted on
 * the last deploy. These pure helpers back that column; the round-trip must be exact
 * (no over-masking) and clearing must store null (no stale set after unbind), and a
 * malformed/legacy value must degrade to "nothing extra masked", never throw.
 */
import { describe, test, expect } from 'bun:test';
import {
	parseInjectedSecretKeys,
	serializeInjectedSecretKeys
} from '../src/lib/server/stack-secret-keys';

describe('serializeInjectedSecretKeys', () => {
	test('non-empty -> JSON array', () => {
		expect(serializeInjectedSecretKeys(['DB_PASSWORD', 'API_KEY'])).toBe('["DB_PASSWORD","API_KEY"]');
	});
	test('empty -> null (clears the column, no stale [] left behind)', () => {
		expect(serializeInjectedSecretKeys([])).toBeNull();
	});
});

describe('parseInjectedSecretKeys', () => {
	test('parses a JSON array of names', () => {
		expect([...parseInjectedSecretKeys('["A","B"]')].sort()).toEqual(['A', 'B']);
	});
	test('null / empty -> empty set', () => {
		expect(parseInjectedSecretKeys(null).size).toBe(0);
		expect(parseInjectedSecretKeys(undefined).size).toBe(0);
		expect(parseInjectedSecretKeys('').size).toBe(0);
	});
	test('malformed / legacy value -> empty set, never throws', () => {
		expect(parseInjectedSecretKeys('not json').size).toBe(0);
		expect(parseInjectedSecretKeys('{"x":1}').size).toBe(0); // object, not array
	});
	test('drops non-string members', () => {
		expect([...parseInjectedSecretKeys('["A",1,null,"B"]')].sort()).toEqual(['A', 'B']);
	});
});

describe('round-trip (no over/under-masking)', () => {
	test('serialize -> parse yields exactly the input names', () => {
		const keys = ['DB_PASSWORD', 'API_KEY', 'REDIS_URL'];
		const stored = serializeInjectedSecretKeys(keys);
		expect([...parseInjectedSecretKeys(stored)].sort()).toEqual([...keys].sort());
	});
	test('a redeploy that injects a DIFFERENT set replaces (not merges) the old one', () => {
		// Deploy 1 stored [A,B]; deploy 2 injects [A,C]. The setter overwrites the
		// whole column, so the mask set tracks the container env exactly - B is gone.
		const afterDeploy2 = serializeInjectedSecretKeys(['A', 'C']);
		expect([...parseInjectedSecretKeys(afterDeploy2)].sort()).toEqual(['A', 'C']);
	});
	test('unbinding a provider (redeploy with no injected keys) clears the set', () => {
		// resolveProviderEnvVars persists [] when nothing was injected -> null.
		const afterUnbind = serializeInjectedSecretKeys([]);
		expect(afterUnbind).toBeNull();
		expect(parseInjectedSecretKeys(afterUnbind).size).toBe(0);
	});
});
