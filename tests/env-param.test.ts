import { describe, test, expect } from 'bun:test';
import { parseEnvParam } from '../src/lib/server/env-param';

describe('parseEnvParam', () => {
	test('null/empty -> null (local/default env)', () => {
		expect(parseEnvParam(null)).toBeNull();
		expect(parseEnvParam('')).toBeNull();
	});

	test('numeric string -> number', () => {
		expect(parseEnvParam('5')).toBe(5);
		expect(parseEnvParam('42')).toBe(42);
	});

	test('non-numeric -> null (not NaN)', () => {
		expect(parseEnvParam('abc')).toBeNull();
	});

	test('leading number is taken (parseInt semantics)', () => {
		expect(parseEnvParam('7x')).toBe(7);
	});
});
