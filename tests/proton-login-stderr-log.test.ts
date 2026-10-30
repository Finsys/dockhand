import { describe, expect, test, afterAll } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loginStderrForLog } from '../src/lib/server/secretproviders/proton-token-core';

/**
 * A failed pass-cli login whose cause is not on the allow-list reaches the user as a
 * bare "login failed", so the server log carries pass-cli's stderr, token cut out.
 */

const TOKEN = `pst_${'b'.repeat(64)}::QUJDREVGR0g`;

describe('loginStderrForLog', () => {
	test('cuts out the whole token and each half', () => {
		const line = loginStderrForLog(`error: login with ${TOKEN} failed\nkey QUJDREVGR0g rejected; token pst_${'b'.repeat(64)} unknown\n`, TOKEN);
		expect(line).toBe('error: login with [REDACTED] failed\nkey [REDACTED] rejected; token [REDACTED] unknown');
	});

	test('keeps the end of a long stderr', () => {
		const line = loginStderrForLog('x'.repeat(5000) + 'Caused by: 429 Too Many Requests');
		expect(line.endsWith('Caused by: 429 Too Many Requests')).toBe(true);
		expect(line.length).toBe(1003);
	});

	test('without a token it only trims', () => {
		expect(loginStderrForLog('  Error: network unreachable \n')).toBe('Error: network unreachable');
	});
});

describe('a failed pass-cli login', () => {
	const dir = mkdtempSync(join(tmpdir(), 'dockhand-passlogin-'));
	const cli = join(dir, 'pass-cli');
	writeFileSync(
		cli,
		`#!/bin/sh
if [ "$1" = "login" ]; then echo "Error: rate limited for $PROTON_PASS_PERSONAL_ACCESS_TOKEN" >&2; echo "Caused by: 429 Too Many Requests" >&2; exit 1; fi
exit 0
`
	);
	chmodSync(cli, 0o755);
	const previous = process.env.DOCKHAND_PASS_CLI_PATH;
	afterAll(() => {
		if (previous === undefined) delete process.env.DOCKHAND_PASS_CLI_PATH;
		else process.env.DOCKHAND_PASS_CLI_PATH = previous;
	});

	test('logs pass-cli stderr with the token cut out, and keeps the user message bare', async () => {
		process.env.DOCKHAND_PASS_CLI_PATH = cli;
		const { protonProvider } = await import('../src/lib/server/secretproviders/proton');
		const warnings: string[] = [];
		const warn = console.warn;
		console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
		try {
			const result = await protonProvider.testConnection({ token: TOKEN } as never);
			expect(result.ok).toBe(false);
			expect(JSON.stringify(result)).not.toContain('429');
		} finally {
			console.warn = warn;
		}
		const line = warnings.find((w) => w.startsWith('[ProtonPass] pass-cli login exited with code 1:'));
		expect(line).toBe('[ProtonPass] pass-cli login exited with code 1: Error: rate limited for [REDACTED]\nCaused by: 429 Too Many Requests');
	});
});

describe('a pass-cli failure after the login', () => {
	const dir = mkdtempSync(join(tmpdir(), 'dockhand-passinfo-'));
	const cli = join(dir, 'pass-cli');
	// The login succeeds; the account check fails with stderr that names an item.
	writeFileSync(
		cli,
		`#!/bin/sh
if [ "$1" = "login" ]; then echo ok; exit 0; fi
if [ "$1" = "logout" ]; then exit 0; fi
echo "Error: item db-root-password could not be read" >&2
exit 1
`
	);
	chmodSync(cli, 0o755);
	const previous = process.env.DOCKHAND_PASS_CLI_PATH;
	afterAll(() => {
		if (previous === undefined) delete process.env.DOCKHAND_PASS_CLI_PATH;
		else process.env.DOCKHAND_PASS_CLI_PATH = previous;
	});

	test('keeps its stderr out of the log: only a login is logged', async () => {
		process.env.DOCKHAND_PASS_CLI_PATH = cli;
		const { protonProvider } = await import('../src/lib/server/secretproviders/proton');
		const lines: string[] = [];
		const warn = console.warn;
		const log = console.log;
		console.warn = (...args: unknown[]) => { lines.push(args.join(' ')); };
		console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
		try {
			const result = await protonProvider.testConnection({ token: TOKEN } as never);
			expect(result.ok).toBe(false);
			expect(JSON.stringify(result)).not.toContain('db-root-password');
		} finally {
			console.warn = warn;
			console.log = log;
		}
		expect(lines.some((l) => l.includes('db-root-password'))).toBe(false);
	});
});
