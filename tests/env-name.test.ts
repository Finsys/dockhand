/**
 * Environment-name validation.
 *
 * #1179 introduced the allowlist; #1228 relaxed it to allow apostrophes
 * after a real user with "Topper's media server" couldn't edit their env.
 *
 * The regex has to accept every name that's already in the wild (we don't
 * silently invalidate user data) while rejecting characters that break path
 * resolution or shell quoting downstream. env.name only ever lands in
 * path.join() and array-form spawn() — never in a shell-interpolated string.
 */

import { describe, test, expect } from 'bun:test';
import { validateEnvName, isValidEnvName, ENV_NAME_MAX_LENGTH } from '../src/lib/utils/env-name';

describe('validateEnvName', () => {
	// Realistic environment names covering every accepted character class.
	const wildNames = [
		'alpha',
		'homelab',
		'docker-ext',
		'docker-websites',
		'old-docker',
		'node1 (ARM)',
		'prod-direct',
		'prod-edge',
		'lab-podman',
		'lab-standard',
		'lab-standard-tls',
		'lab-tls',
		'nas-box',
		// Other realistic names
		'production',
		'staging.local',
		'app+v2',
		'server@home',
		'env_with_underscore',
		'a' // single-char names are allowed
	];

	for (const name of wildNames) {
		test(`accepts: ${name}`, () => {
			expect(isValidEnvName(name)).toBe(true);
		});
	}

	// #1228 — apostrophes are safe and must be accepted.
	describe('apostrophe (#1228)', () => {
		const apostropheNames = [
			"Topper's media server", // exact name from the bug report
			"o'malley",
			"jane's lab",
			"d'artagnan",
			"'leading-apostrophe", // apostrophe is valid as first char
			"trailing-apostrophe'", // valid as last char
			"a'b'c'd", // multiple apostrophes
			"it's a (test) + @home" // mixed with other allowed specials
		];
		for (const name of apostropheNames) {
			test(`accepts: ${JSON.stringify(name)}`, () => {
				const result = validateEnvName(name);
				expect(result.ok).toBe(true);
				expect(result.reason).toBeUndefined();
			});
		}
	});

	// Each allowed special character in isolation.
	describe('individual allowed specials', () => {
		const cases: Array<[string, string]> = [
			['env-name', 'hyphen'],
			['env_name', 'underscore'],
			['env.name', 'dot (non-trailing)'],
			['env name', 'space'],
			['env+name', 'plus'],
			['env@name', 'at-sign'],
			['(parens)', 'parens'],
			["env'name", 'apostrophe']
		];
		for (const [name, label] of cases) {
			test(`accepts ${label}: ${name}`, () => {
				expect(isValidEnvName(name)).toBe(true);
			});
		}
	});

	// Length boundary.
	describe('length', () => {
		test('rejects empty string', () => {
			const r = validateEnvName('');
			expect(r.ok).toBe(false);
			expect(r.reason).toBe('Name is required');
		});

		test('accepts exactly max length', () => {
			expect(isValidEnvName('a'.repeat(ENV_NAME_MAX_LENGTH))).toBe(true);
		});

		test('rejects max length + 1', () => {
			const r = validateEnvName('a'.repeat(ENV_NAME_MAX_LENGTH + 1));
			expect(r.ok).toBe(false);
			expect(r.reason).toContain(String(ENV_NAME_MAX_LENGTH));
		});

		test('accepts single character', () => {
			expect(isValidEnvName('a')).toBe(true);
			expect(isValidEnvName('1')).toBe(true);
			expect(isValidEnvName('_')).toBe(true);
			expect(isValidEnvName("'")).toBe(true);
		});

		test('rejects single space', () => {
			expect(isValidEnvName(' ')).toBe(false);
		});

		test('accepts single dot', () => {
			// Single-char names skip the last-char rule (the regex tail group
			// is optional). "." alone is unusual but not actively harmful.
			expect(isValidEnvName('.')).toBe(true);
		});
	});

	// First-char rule: no leading whitespace.
	describe('leading whitespace', () => {
		const cases = [' a', '  a', '\ta', '\na'];
		for (const name of cases) {
			test(`rejects: ${JSON.stringify(name)}`, () => {
				expect(isValidEnvName(name)).toBe(false);
			});
		}
	});

	// Last-char rule: no trailing whitespace, no trailing dot.
	describe('trailing whitespace / dot', () => {
		const cases = ['a ', 'a  ', 'a\t', 'a.', 'foo.bar.', 'name.'];
		for (const name of cases) {
			test(`rejects: ${JSON.stringify(name)}`, () => {
				expect(isValidEnvName(name)).toBe(false);
			});
		}
	});

	// Deny list — these MUST stay rejected. Each maps to a category named in
	// the user-facing error message.
	describe('deny list', () => {
		const rejected: Array<[string, string]> = [
			['env/with/slash', 'forward slash (path traversal)'],
			['env\\back', 'backslash (path traversal)'],
			['myenv*', 'trailing asterisk (#1179 reporter case)'],
			['my*env', 'inline asterisk (glob)'],
			['my?env', 'glob ?'],
			['my[env]', 'glob brackets'],
			['env;rm', 'semicolon (shell)'],
			['env$VAR', 'shell var substitution'],
			['env`cmd`', 'backticks (shell)'],
			['env"quote', 'double quote'],
			['env:colon', 'colon (drive sep / id parsing)'],
			['env|pipe', 'pipe'],
			['env&amp', 'ampersand'],
			['env<redir', 'redirect <'],
			['env>redir', 'redirect >'],
			['#hash', 'leading hash'],
			['env\nnewline', 'newline'],
			['env\rcr', 'carriage return'],
			['env\0null', 'null byte'],
			['env{brace}', 'brace expansion'],
			['env~tilde', 'tilde'],
			['env%percent', 'percent'],
			['env!bang', 'history expansion']
		];

		for (const [name, why] of rejected) {
			test(`rejects: ${JSON.stringify(name)} (${why})`, () => {
				const result = validateEnvName(name);
				expect(result.ok).toBe(false);
				expect(result.reason).toBeTruthy();
			});
		}
	});

	// Non-ASCII: rule is ASCII-only by design (avoids normalization /
	// homoglyph / Windows codepage surprises).
	describe('non-ASCII', () => {
		const cases = ['café', 'тест', '日本語', 'émojis-🚀', 'naïve'];
		for (const name of cases) {
			test(`rejects: ${name}`, () => {
				expect(isValidEnvName(name)).toBe(false);
			});
		}
	});

	test('rejects non-string input', () => {
		expect(validateEnvName(undefined as unknown).ok).toBe(false);
		expect(validateEnvName(null as unknown).ok).toBe(false);
		expect(validateEnvName(123 as unknown).ok).toBe(false);
		expect(validateEnvName({} as unknown).ok).toBe(false);
		expect(validateEnvName([] as unknown).ok).toBe(false);
		expect(validateEnvName(true as unknown).ok).toBe(false);
	});

	// Error message shape — keep the deny-list summary tight.
	describe('error message', () => {
		test('empty → "Name is required"', () => {
			expect(validateEnvName('').reason).toBe('Name is required');
		});

		test('non-string → "Name is required"', () => {
			expect(validateEnvName(undefined as unknown).reason).toBe('Name is required');
		});

		test('too long → mentions max length', () => {
			const r = validateEnvName('a'.repeat(ENV_NAME_MAX_LENGTH + 1));
			expect(r.reason).toContain(String(ENV_NAME_MAX_LENGTH));
		});

		test('disallowed character → deny-list message', () => {
			const r = validateEnvName('bad/name');
			expect(r.reason).toContain('slashes');
			expect(r.reason).toContain('wildcards');
		});
	});
});
