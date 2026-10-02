import { describe, expect, test } from 'bun:test';
import {
	cliTimeoutMs,
	cliTimeoutMessage,
	MAX_TIMER_MS
} from '../src/lib/server/secretproviders/cli-timeout-core';

/**
 * The operator-facing half of a provider CLI timeout: how the limit is read, and
 * what the failure says. A value that disabled the bound would let a hung CLI
 * hold the session queue, so unusable input has to keep the default.
 */

describe('cliTimeoutMs', () => {
	test('uses the configured value', () => {
		expect(cliTimeoutMs('60000', 30_000)).toBe(60_000);
	});

	test('tolerates surrounding whitespace', () => {
		expect(cliTimeoutMs('  45000 ', 30_000)).toBe(45_000);
	});

	test('falls back when unset', () => {
		expect(cliTimeoutMs(undefined, 30_000)).toBe(30_000);
		expect(cliTimeoutMs('', 30_000)).toBe(30_000);
	});

	test('rejects values that would remove the bound', () => {
		// Zero or negative would mean "no timeout", which is what the bound exists
		// to prevent; a typo must not silently disable it either.
		expect(cliTimeoutMs('0', 30_000)).toBe(30_000);
		expect(cliTimeoutMs('-1', 30_000)).toBe(30_000);
		expect(cliTimeoutMs('soon', 30_000)).toBe(30_000);
		expect(cliTimeoutMs('Infinity', 30_000)).toBe(30_000);
		expect(cliTimeoutMs('NaN', 30_000)).toBe(30_000);
	});

	test('floors a fractional value to whole milliseconds', () => {
		expect(cliTimeoutMs('1500.7', 30_000)).toBe(1500);
	});

	test('a sub-millisecond value keeps the default rather than flooring to zero', () => {
		// Flooring after the positive check would turn 0.5 into 0, firing the timer
		// on the next tick and failing every call instantly.
		expect(cliTimeoutMs('0.5', 30_000)).toBe(30_000);
		expect(cliTimeoutMs('0.9', 30_000)).toBe(30_000);
	});

	test('clamps past the 32-bit timer ceiling, which would otherwise fire in 1ms', () => {
		// An operator reaching for "effectively unlimited" must not get the opposite.
		expect(cliTimeoutMs('99999999999', 30_000)).toBe(MAX_TIMER_MS);
		expect(cliTimeoutMs('2147483648', 30_000)).toBe(MAX_TIMER_MS);
		expect(cliTimeoutMs(String(MAX_TIMER_MS), 30_000)).toBe(MAX_TIMER_MS);
	});
});

describe('cliTimeoutMessage', () => {
	test('names the phase that hung', () => {
		// The phase is the diagnosis: a hung login is network or credentials, a
		// hung lookup is a slow vault.
		const msg = cliTimeoutMessage('Proton Pass', 'login', 30_000, 'PROTON_LOGIN_TIMEOUT_MS');
		expect(msg).toContain('login');
		expect(msg).not.toContain('secret lookup');
	});

	test('names the env var that raises the limit', () => {
		const msg = cliTimeoutMessage('Proton Pass', 'login', 30_000, 'PROTON_LOGIN_TIMEOUT_MS');
		expect(msg).toContain('PROTON_LOGIN_TIMEOUT_MS');
	});

	test('reports the limit that was actually applied, in seconds', () => {
		expect(cliTimeoutMessage('Proton Pass', 'login', 30_000, 'X')).toContain('30s');
		expect(cliTimeoutMessage('Proton Pass', 'login', 45_000, 'X')).toContain('45s');
		// A sub-second override still reads sensibly rather than as "0s".
		expect(cliTimeoutMessage('Proton Pass', 'login', 300, 'X')).toContain('0.3s');
	});

	test('distinguishes the phases from one another', () => {
		const lookup = cliTimeoutMessage('Proton Pass', 'secret lookup', 30_000, 'X');
		expect(lookup).toContain('secret lookup');
		expect(lookup).not.toContain('login');
	});
});
