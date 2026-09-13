import { describe, test, expect } from 'bun:test';
import { redactSecretValues, redactSecretVars } from '../src/lib/server/secret-redact';

describe('redactSecretValues', () => {
	test('replaces a secret value with [REDACTED]', () => {
		const out = redactSecretValues('exec: "s3cr3t-pw": not found', ['s3cr3t-pw']);
		expect(out).toBe('exec: "[REDACTED]": not found');
		expect(out).not.toContain('s3cr3t-pw');
	});

	test('replaces every occurrence', () => {
		const out = redactSecretValues('pw=hunter2 again hunter2', ['hunter2']);
		expect(out).toBe('pw=[REDACTED] again [REDACTED]');
	});

	test('redacts multiple distinct values', () => {
		const out = redactSecretValues('a=alpha11 b=bravo22', ['alpha11', 'bravo22']);
		expect(out).toBe('a=[REDACTED] b=[REDACTED]');
	});

	test('masks the longest value fully when one contains another', () => {
		// 'superpassword' contains 'password'; longest-first prevents a partial leak.
		const out = redactSecretValues('x=superpassword', ['password', 'superpassword']);
		expect(out).toBe('x=[REDACTED]');
		expect(out).not.toContain('password');
	});

	test('skips values shorter than 4 chars (would corrupt ordinary output)', () => {
		const out = redactSecretValues('exit code 1, port 22', ['1', '22']);
		expect(out).toBe('exit code 1, port 22');
	});

	test('returns text unchanged when no values match', () => {
		expect(redactSecretValues('nothing secret here', ['absent-value'])).toBe('nothing secret here');
	});

	test('handles empty text and empty values', () => {
		expect(redactSecretValues('', ['secret'])).toBe('');
		expect(redactSecretValues('text', [])).toBe('text');
	});

	test('dedupes repeated values without error', () => {
		const out = redactSecretValues('v=mysecretv', ['mysecretv', 'mysecretv']);
		expect(out).toBe('v=[REDACTED]');
	});
});

describe('redactSecretVars', () => {
	test('redacts the values of a secret-vars map', () => {
		const out = redactSecretVars('DB error: pass=topsecret123', { DB_PASSWORD: 'topsecret123' });
		expect(out).toBe('DB error: pass=[REDACTED]');
	});

	test('undefined map returns text unchanged', () => {
		expect(redactSecretVars('anything', undefined)).toBe('anything');
	});

	test('only the VALUE is redacted, not the key name', () => {
		const out = redactSecretVars('DB_PASSWORD not set: topsecret123', { DB_PASSWORD: 'topsecret123' });
		expect(out).toContain('DB_PASSWORD');
		expect(out).not.toContain('topsecret123');
	});
});
