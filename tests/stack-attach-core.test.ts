import { describe, test, expect } from 'bun:test';
import { buildAttachEnvVars, type StackEnvVar } from '../src/lib/server/stack-attach-core';

// Pins the env-var merge that runs when an internal stack is converted to a git stack.
// This is data handling (a wrong merge silently drops or corrupts a user's env vars on
// conversion), so every branch of the precedence rule is covered.
describe('buildAttachEnvVars', () => {
	test('file vars form a non-secret base', () => {
		const out = buildAttachEnvVars({ A: '1', B: '2' }, null, []);
		expect(out).toEqual([
			{ key: 'A', value: '1', isSecret: false },
			{ key: 'B', value: '2', isSecret: false }
		]);
	});

	test('a db non-secret var overrides the file value for its key', () => {
		const out = buildAttachEnvVars({ TZ: 'UTC' }, [{ key: 'TZ', value: 'Europe/Bucharest', isSecret: false }], []);
		expect(out).toEqual([{ key: 'TZ', value: 'Europe/Bucharest', isSecret: false }]);
	});

	test('a db var with a key absent from the file is added', () => {
		const out = buildAttachEnvVars({ A: '1' }, [{ key: 'NEW', value: 'x', isSecret: false }], []);
		expect(out).toContainEqual({ key: 'A', value: '1', isSecret: false });
		expect(out).toContainEqual({ key: 'NEW', value: 'x', isSecret: false });
	});

	test('a masked secret (***) keeps the stored ciphertext, never saves the mask', () => {
		const existing: StackEnvVar[] = [{ key: 'API_KEY', value: 'enc:v1:ciphertext', isSecret: true }];
		const out = buildAttachEnvVars(null, [{ key: 'API_KEY', value: '***', isSecret: true }], existing);
		expect(out).toEqual([{ key: 'API_KEY', value: 'enc:v1:ciphertext', isSecret: true }]);
	});

	test('a masked secret with no stored secret counterpart is dropped (no real value)', () => {
		const out = buildAttachEnvVars(null, [{ key: 'GHOST', value: '***', isSecret: true }], []);
		expect(out).toEqual([]);
	});

	test('a secret sent with a real (non-masked) value is saved as given', () => {
		const out = buildAttachEnvVars(null, [{ key: 'TOKEN', value: 'actual-new-value', isSecret: true }], []);
		expect(out).toEqual([{ key: 'TOKEN', value: 'actual-new-value', isSecret: true }]);
	});

	test('with no db vars, stored secrets are carried forward and file vars kept', () => {
		const existing: StackEnvVar[] = [
			{ key: 'DB_PASS', value: 'enc:v1:xyz', isSecret: true },
			{ key: 'PLAIN', value: 'ignored', isSecret: false }
		];
		const out = buildAttachEnvVars({ HOST: 'localhost' }, null, existing);
		// File var kept; the stored SECRET carried forward; the stored NON-secret is NOT
		// re-added (the .env file is the source of truth for non-secrets).
		expect(out).toContainEqual({ key: 'HOST', value: 'localhost', isSecret: false });
		expect(out).toContainEqual({ key: 'DB_PASS', value: 'enc:v1:xyz', isSecret: true });
		expect(out.some((v) => v.key === 'PLAIN')).toBe(false);
	});

	test('a db var overriding a file key as a secret wins (db value, isSecret true)', () => {
		const out = buildAttachEnvVars({ K: 'from-file' }, [{ key: 'K', value: 'real-secret', isSecret: true }], []);
		expect(out).toEqual([{ key: 'K', value: 'real-secret', isSecret: true }]);
	});

	test('a db var with a blank key is skipped', () => {
		const out = buildAttachEnvVars({ A: '1' }, [{ key: '   ', value: 'x', isSecret: false }], []);
		expect(out).toEqual([{ key: 'A', value: '1', isSecret: false }]);
	});
});
