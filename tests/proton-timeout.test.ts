import { describe, expect, test, afterAll } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * What a pass-cli timeout tells the operator, and whether they can raise it.
 *
 * A timeout names one of three very different failures - the login, the vault
 * listing, or a single reference lookup - and the report that motivated this
 * could not be told apart from a slow vault because the message named none of
 * them. The limit is also the only thing standing between a slow network and a
 * failed deploy, so it has to be reachable without a new release.
 */

const dir = mkdtempSync(join(tmpdir(), 'dockhand-passtimeout-'));
const cli = join(dir, 'pass-cli');

// Hangs on login only, so the timeout under test is unambiguously the login one.
writeFileSync(
	cli,
	`#!/bin/sh
if [ "$1" = "login" ]; then sleep 30; echo ok; exit 0; fi
if [ "$1" = "logout" ]; then echo bye; exit 0; fi
echo '{}'
exit 0
`
);
chmodSync(cli, 0o755);

process.env.DOCKHAND_PASS_CLI_PATH = cli;
process.env.PROTON_LOGIN_TIMEOUT_MS = '300';
const { protonProvider } = await import('../src/lib/server/secretproviders/proton');

// Shape-valid so the provider's own format check passes; the stub CLI never
// contacts Proton, so the value itself is irrelevant.
const TOKEN = `pst_${'a'.repeat(64)}::QUJDREVG`;

afterAll(() => {
	delete process.env.DOCKHAND_PASS_CLI_PATH;
	delete process.env.PROTON_LOGIN_TIMEOUT_MS;
});

describe('a pass-cli timeout', () => {
	test('is attributed to the login, not to "a command"', async () => {
		const result = await protonProvider.testConnection({ token: TOKEN } as never);

		expect(result.ok).toBe(false);
		// The phase is what makes the failure actionable: a hung login is a network
		// or credential problem, a hung lookup is a slow vault. Matched as the
		// phrase, since the env var name also contains the word "login".
		expect(result.error).toContain('Proton Pass login timed out');
	}, 20_000);

	test('names the env var that raises it, so it can be fixed without a release', async () => {
		const result = await protonProvider.testConnection({ token: TOKEN } as never);

		expect(result.error).toContain('PROTON_LOGIN_TIMEOUT_MS');
	}, 20_000);

	test('honours the configured limit instead of the built-in default', async () => {
		// 300ms is set above; the 30s default would make this take far longer.
		const started = Date.now();
		await protonProvider.testConnection({ token: TOKEN } as never);
		expect(Date.now() - started).toBeLessThan(10_000);
	}, 20_000);
});

/**
 * The phases beyond login. Each names a different cause - a slow vault is not a
 * slow network - so a mislabelled one sends the operator after the wrong thing.
 */
describe('a timeout past the login', () => {
	const cmdDir = mkdtempSync(join(tmpdir(), 'dockhand-passcmd-'));
	const cmdCli = join(cmdDir, 'pass-cli');

	// Logs in instantly and hangs on every item operation, so the phase under
	// test is the vault listing or the per-reference lookup, never the login.
	writeFileSync(
		cmdCli,
		`#!/bin/sh
if [ "$1" = "item" ]; then sleep 30; fi
if [ "$1" = "logout" ]; then echo bye; exit 0; fi
echo '{}'
exit 0
`
	);
	chmodSync(cmdCli, 0o755);

	test('a hung vault listing is reported as the listing, with its own env var', async () => {
		process.env.DOCKHAND_PASS_CLI_PATH = cmdCli;
		process.env.PROTON_COMMAND_TIMEOUT_MS = '300';
		try {
			const failure = await protonProvider
				.resolveBulk({ token: TOKEN } as never, 'myvault')
				.then(() => null)
				.catch((e: unknown) => (e instanceof Error ? e.message : String(e)));

			expect(failure).toContain('Proton Pass vault listing timed out');
			// The login var would not move this limit, so it must not be the one named.
			expect(failure).toContain('PROTON_COMMAND_TIMEOUT_MS');
			expect(failure).not.toContain('PROTON_LOGIN_TIMEOUT_MS');
		} finally {
			process.env.DOCKHAND_PASS_CLI_PATH = cli;
			delete process.env.PROTON_COMMAND_TIMEOUT_MS;
		}
	}, 20_000);

	test('the command limit is read, not the built-in default', async () => {
		process.env.DOCKHAND_PASS_CLI_PATH = cmdCli;
		process.env.PROTON_COMMAND_TIMEOUT_MS = '300';
		try {
			const started = Date.now();
			await protonProvider.resolveBulk({ token: TOKEN } as never, 'myvault').catch(() => undefined);
			expect(Date.now() - started).toBeLessThan(10_000);
		} finally {
			process.env.DOCKHAND_PASS_CLI_PATH = cli;
			delete process.env.PROTON_COMMAND_TIMEOUT_MS;
		}
	}, 20_000);
});

/**
 * A pass-cli that exits non-zero is reported once, with whatever reason it gave.
 */
describe('a session that fails for a real reason', () => {
	const failDir = mkdtempSync(join(tmpdir(), 'dockhand-passfail-'));
	const failCli = join(failDir, 'pass-cli');
	const attempts = join(failDir, 'attempts');

	// Login always fails outright - no hang, a real non-zero exit.
	writeFileSync(
		failCli,
		`#!/bin/sh
if [ "$1" = "login" ]; then
  n=$(cat "${attempts}" 2>/dev/null || echo 0)
  echo $((n + 1)) > "${attempts}"
  echo "Caused by:" >&2
  echo "    0: This personal access token is invalid, expired or has been deleted." >&2
  exit 1
fi
if [ "$1" = "logout" ]; then echo bye; exit 0; fi
echo '{}'
exit 0
`
	);
	chmodSync(failCli, 0o755);

	test('runs the binary once and reports its failure', async () => {
		process.env.DOCKHAND_PASS_CLI_PATH = failCli;
		try {
			const result = await protonProvider.testConnection({ token: TOKEN } as never);
			expect(result.ok).toBe(false);
			expect(readFileSync(attempts, 'utf8').trim()).toBe('1');
			expect(result.error).not.toContain('timed out');
		} finally {
			process.env.DOCKHAND_PASS_CLI_PATH = cli;
		}
	}, 20_000);

	test('the reason pass-cli gave reaches the caller', async () => {
		// Without this, the operator is told only that a command failed, which is
		// what made an expired token impossible to tell from a network problem.
		process.env.DOCKHAND_PASS_CLI_PATH = failCli;
		try {
			const result = await protonProvider.testConnection({ token: TOKEN } as never);
			expect(result.error).toContain('invalid, expired or has been deleted');
			// Named by phase, so a failing lookup is not read as a failing login.
			expect(result.error).toContain('login');
		} finally {
			process.env.DOCKHAND_PASS_CLI_PATH = cli;
		}
	}, 20_000);
});

/**
 * pass-cli states the cause in a "Caused by:" chain whose first line is a generic
 * wrapper, so the deepest entry is the one the operator needs.
 */
describe('a failure reported through a cause chain', () => {
	const chainDir = mkdtempSync(join(tmpdir(), 'dockhand-passchain-'));
	const chainCli = join(chainDir, 'pass-cli');

	writeFileSync(
		chainCli,
		`#!/bin/sh
if [ "$1" = "login" ]; then
  echo "Error: Error in personal access token login flow" >&2
  echo "" >&2
  echo "Caused by:" >&2
  echo "    0: Error creating personal access token session" >&2
  echo "    1: This personal access token is invalid, expired or has been deleted." >&2
  exit 1
fi
if [ "$1" = "logout" ]; then echo bye; exit 0; fi
echo '{}'
exit 0
`
	);
	chmodSync(chainCli, 0o755);

	test('surfaces the deepest cause, not the generic wrapper', async () => {
		process.env.DOCKHAND_PASS_CLI_PATH = chainCli;
		try {
			const result = await protonProvider.testConnection({ token: TOKEN } as never);
			expect(result.error).toContain('invalid, expired or has been deleted');
			expect(result.error).not.toContain('Error in personal access token login flow');
		} finally {
			process.env.DOCKHAND_PASS_CLI_PATH = cli;
		}
	}, 20_000);
});

/**
 * The format check runs before anything is spawned, so a token that cannot work
 * is named rather than handed to the CLI for a generic failure.
 */
describe('a token of the wrong shape', () => {
	test('is rejected without running pass-cli', async () => {
		const marker = join(tmpdir(), `dockhand-spawned-${Date.now()}`);
		const spyDir = mkdtempSync(join(tmpdir(), 'dockhand-passspy-'));
		const spyCli = join(spyDir, 'pass-cli');
		writeFileSync(spyCli, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
		chmodSync(spyCli, 0o755);

		process.env.DOCKHAND_PASS_CLI_PATH = spyCli;
		try {
			const result = await protonProvider.testConnection({ token: 'pst_truncated' } as never);
			expect(result.ok).toBe(false);
			expect(result.error).toContain('malformed');
			// The whole point: no process at all, so no 30s wait on a doomed login.
			expect(existsSync(marker)).toBe(false);
		} finally {
			process.env.DOCKHAND_PASS_CLI_PATH = cli;
		}
	}, 20_000);
});
