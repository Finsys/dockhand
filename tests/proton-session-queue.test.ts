import { describe, expect, test, afterAll } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * That Proton Pass sessions really are serialized, driven through the provider.
 *
 * pass-cli keeps one session per user, so two logins contend even though each
 * call gets a private session directory. The editor probes the provider while a
 * deploy resolves its secrets, and a second login that waits out its own timeout
 * fails the deploy. The queue lives in withSession, which no unit can reach
 * directly - so this drives the real provider against a stand-in binary.
 */

const dir = mkdtempSync(join(tmpdir(), 'dockhand-passtest-'));
const cli = join(dir, 'pass-cli');
const log = join(dir, 'calls.log');

// Records an overlap the moment two logins are alive at once, which is exactly
// what the serializer exists to prevent.
writeFileSync(
	cli,
	`#!/bin/sh
LIVE="${dir}/live"
if [ "$1" = "login" ]; then
  if [ -e "$LIVE" ]; then echo overlap >> "${log}"; fi
  : > "$LIVE"
  sleep 0.3
  rm -f "$LIVE"
  echo ok
  exit 0
fi
if [ "$1" = "logout" ]; then echo bye; exit 0; fi
echo '{}'
exit 0
`
);
chmodSync(cli, 0o755);

process.env.DOCKHAND_PASS_CLI_PATH = cli;
const { protonProvider } = await import('../src/lib/server/secretproviders/proton');

// Shape-valid so the provider's own format check passes; the stub CLI never
// contacts Proton, so the value itself is irrelevant.
const TOKEN = `pst_${'a'.repeat(64)}::QUJDREVG`;

afterAll(() => {
	delete process.env.DOCKHAND_PASS_CLI_PATH;
});

describe('two callers never log in at once', () => {
	test('concurrent provider calls are serialized', async () => {
		// testConnection and resolveBulk are the two paths a probe and a deploy
		// actually take, and they must share one queue.
		await Promise.all([
			protonProvider.testConnection({ token: TOKEN } as never),
			protonProvider.resolveBulk({ token: TOKEN } as never, 'vault').catch(() => undefined),
			protonProvider.testConnection({ token: TOKEN } as never)
		]);

		const overlaps = existsSync(log) ? readFileSync(log, 'utf8').trim() : '';
		expect(overlaps).toBe('');
	}, 30_000);
});

describe('a bad executable path', () => {
	test('still reports the configuration error, not a queue error', async () => {
		// executablePath() is read before queueing, so a misconfigured path must
		// surface as itself rather than as a timeout.
		process.env.DOCKHAND_PASS_CLI_PATH = 'not/absolute';
		const result = await protonProvider.testConnection({ token: TOKEN } as never);
		process.env.DOCKHAND_PASS_CLI_PATH = cli;

		expect(result.ok).toBe(false);
		expect(result.error).toContain('absolute');
	});
});
