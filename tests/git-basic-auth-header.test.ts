/**
 * Regression test for #1273 — HTTPS token auth with an empty username.
 *
 * A token credential with a blank username produced a Basic header of
 * base64(":token"). GitHub rejects that with 401 and git falls back to an
 * interactive prompt, dying with "could not read Username ... terminal prompts
 * disabled". buildBasicAuthHeader must default an empty username to a non-empty
 * placeholder (`x-access-token`) so GitHub accepts the header.
 */
import { describe, test, expect } from 'bun:test';
import { buildBasicAuthHeader } from '../src/lib/server/git-auth';

function decode(header: string): string {
	const b64 = header.replace(/^Authorization: Basic /, '');
	return Buffer.from(b64, 'base64').toString('utf8');
}

describe('buildBasicAuthHeader (#1273)', () => {
	test('empty username defaults to x-access-token (not base64(":token"))', () => {
		const header = buildBasicAuthHeader('', 'ghp_sometoken');
		// The bug: empty username → "..:token". The fix: "x-access-token:token".
		expect(decode(header)).toBe('x-access-token:ghp_sometoken');
		expect(decode(header).startsWith(':')).toBe(false);
	});

	test('a user-supplied username is preserved', () => {
		const header = buildBasicAuthHeader('user', 'ghp_sometoken');
		expect(decode(header)).toBe('user:ghp_sometoken');
	});

	test('produces a well-formed Basic Authorization header', () => {
		const header = buildBasicAuthHeader('x-access-token', 'tok');
		expect(header).toBe(`Authorization: Basic ${Buffer.from('x-access-token:tok').toString('base64')}`);
	});
});
