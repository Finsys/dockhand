/** Focused tests for the external-bws Bitwarden Secrets Manager provider. */

// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { bitwardenProvider } = await import('../src/lib/server/secretproviders/bitwarden.ts');
const { getProvider } = await import('../src/lib/server/secretproviders/index.ts');
const { UnsupportedOperationError } = await import('../src/lib/server/secretproviders/shared.ts');

const PROJECT_ID = '123e4567-e89b-42d3-a456-426614174000';
const TOKEN = 'test-machine-account-token';
const originalBwsPath = process.env.DOCKHAND_BWS_PATH;
let testDir = '';
let fakeCounter = 0;

beforeEach(async () => {
	testDir = await mkdtemp(join(tmpdir(), 'dockhand-bitwarden-test-'));
	delete process.env.DOCKHAND_BWS_PATH;
	process.env.UNRELATED_DOCKHAND_SECRET = 'must-not-reach-child';
});

afterEach(async () => {
	if (originalBwsPath === undefined) delete process.env.DOCKHAND_BWS_PATH;
	else process.env.DOCKHAND_BWS_PATH = originalBwsPath;
	delete process.env.UNRELATED_DOCKHAND_SECRET;
	await rm(testDir, { recursive: true, force: true });
});

async function installFakeBws(source: string): Promise<string> {
	const path = join(testDir, `bws-${fakeCounter++}`);
	await writeFile(path, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
	await chmod(path, 0o700);
	process.env.DOCKHAND_BWS_PATH = path;
	return path;
}

async function installSecretResponse(payloadSource: string): Promise<void> {
	await installFakeBws(`
const args = process.argv.slice(2);
if (JSON.stringify(args) !== JSON.stringify(['secret', 'list', '${PROJECT_ID}', '--output', 'json', '--color', 'no'])) process.exit(41);
if (process.env.BWS_ACCESS_TOKEN !== '${TOKEN}') process.exit(42);
if (args.includes('${TOKEN}') || process.env.UNRELATED_DOCKHAND_SECRET) process.exit(43);
process.stdout.write(${payloadSource});
`);
}

describe('bitwardenProvider capabilities', () => {
	test('is registered as a bulk-only provider', () => {
		expect(getProvider('bitwarden')).toBe(bitwardenProvider);
		expect(bitwardenProvider.type).toBe('bitwarden');
		expect(bitwardenProvider.label).toBe('Bitwarden Secrets Manager');
		expect(bitwardenProvider.supportsBulk).toBe(true);
		expect(bitwardenProvider.supportsReferences).toBe(false);
		expect(bitwardenProvider.isReference('bw://anything')).toBe(false);
	});

	test('rejects inline reference resolution', async () => {
		await expect(bitwardenProvider.resolveSecretReferences({ token: TOKEN }, [])).rejects.toThrow(
			UnsupportedOperationError
		);
	});
});

describe('testConnection', () => {
	test('checks the compatible version, then performs an authenticated project query', async () => {
		const logPath = join(testDir, 'calls.jsonl');
		await installFakeBws(`
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  args,
  hasToken: Boolean(process.env.BWS_ACCESS_TOKEN),
  home: process.env.HOME,
  sameHome: process.env.HOME === process.env.XDG_CONFIG_HOME,
  leaked: Boolean(process.env.UNRELATED_DOCKHAND_SECRET)
}) + '\\n');
if (args.length === 1 && args[0] === '--version') {
  if (process.env.BWS_ACCESS_TOKEN) process.exit(51);
  console.log('bws 2.1.0');
} else if (JSON.stringify(args) === JSON.stringify(['project', 'list', '--output', 'json', '--color', 'no'])) {
  if (process.env.BWS_ACCESS_TOKEN !== '${TOKEN}' || args.includes('${TOKEN}')) process.exit(52);
  console.log('[]');
} else {
  process.exit(53);
}
`);

		expect(await bitwardenProvider.testConnection({ token: TOKEN })).toEqual({ ok: true });
		const calls = (await readFile(logPath, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(calls.map((call) => call.args)).toEqual([
			['--version'],
			['project', 'list', '--output', 'json', '--color', 'no']
		]);
		expect(calls[0].hasToken).toBe(false);
		expect(calls[1].hasToken).toBe(true);
		expect(calls.every((call) => call.sameHome && !call.leaked)).toBe(true);
		expect(calls.every((call) => !existsSync(call.home))).toBe(true);
	});

	test('configures a safe self-hosted server in the isolated profile before authentication', async () => {
		const logPath = join(testDir, 'self-hosted-calls.jsonl');
		await installFakeBws(`
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  args,
  hasToken: Boolean(process.env.BWS_ACCESS_TOKEN),
  home: process.env.HOME
}) + '\\n');
if (args.length === 1 && args[0] === '--version') {
  console.log('bws 2.1.0');
} else if (JSON.stringify(args) === JSON.stringify(['config', 'server-base', 'https://bitwarden.example.com'])) {
  if (process.env.BWS_ACCESS_TOKEN) process.exit(54);
} else if (JSON.stringify(args) === JSON.stringify(['project', 'list', '--output', 'json', '--color', 'no'])) {
  if (process.env.BWS_ACCESS_TOKEN !== '${TOKEN}') process.exit(55);
  console.log('[]');
} else {
  process.exit(56);
}
`);

		expect(
			await bitwardenProvider.testConnection({
				token: TOKEN,
				serverUrl: '  https://bitwarden.example.com/  '
			})
		).toEqual({ ok: true });
		const calls = (await readFile(logPath, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(calls.map((call) => call.args)).toEqual([
			['--version'],
			['config', 'server-base', 'https://bitwarden.example.com'],
			['project', 'list', '--output', 'json', '--color', 'no']
		]);
		expect(calls.map((call) => call.hasToken)).toEqual([false, false, true]);
		expect(calls[1].home).toBe(calls[2].home);
		expect(calls.every((call) => !existsSync(call.home))).toBe(true);
	});

	test('rejects an unsafe self-hosted server before executing bws', async () => {
		process.env.DOCKHAND_BWS_PATH = join(testDir, 'missing-bws');
		expect(
			await bitwardenProvider.testConnection({ token: TOKEN, serverUrl: 'http://127.0.0.1' })
		).toEqual({
			ok: false,
			error:
				'Bitwarden Secrets Manager: host not allowed (loopback address (127.0.0.1) blocked)'
		});
	});

	test('rejects missing, relative-path, and incompatible clients with sanitized errors', async () => {
		process.env.DOCKHAND_BWS_PATH = join(testDir, 'missing-bws');
		expect(await bitwardenProvider.testConnection({ token: TOKEN })).toEqual({
			ok: false,
			error: 'Bitwarden bws executable was not found'
		});

		process.env.DOCKHAND_BWS_PATH = 'relative/bws';
		expect(await bitwardenProvider.testConnection({ token: TOKEN })).toEqual({
			ok: false,
			error: 'Bitwarden bws executable path must be absolute'
		});

		for (const version of ['2.0.9', '2.1.0-beta.1', '3.0.0']) {
			await installFakeBws(`console.log('bws ${version}');`);
			expect(await bitwardenProvider.testConnection({ token: TOKEN })).toEqual({
				ok: false,
				error: 'Bitwarden bws version must be >=2.1.0 and <3.0.0'
			});
		}
	});

	test('rejects an empty token before executing bws', async () => {
		process.env.DOCKHAND_BWS_PATH = join(testDir, 'missing-bws');
		expect(await bitwardenProvider.testConnection({ token: '  ' })).toEqual({
			ok: false,
			error: 'Bitwarden Machine Account access token is empty'
		});
	});
});

describe('resolveBulk', () => {
	test('uses the exact command and returns a null-prototype string record', async () => {
		const statePath = join(testDir, 'state-home');
		await installFakeBws(`
const fs = require('node:fs');
const args = process.argv.slice(2);
if (JSON.stringify(args) !== JSON.stringify(['secret', 'list', '${PROJECT_ID}', '--output', 'json', '--color', 'no'])) process.exit(61);
if (process.env.BWS_ACCESS_TOKEN !== '${TOKEN}' || args.includes('${TOKEN}')) process.exit(62);
if (process.env.UNRELATED_DOCKHAND_SECRET || process.env.HOME !== process.env.XDG_CONFIG_HOME) process.exit(63);
fs.writeFileSync(${JSON.stringify(statePath)}, process.env.HOME);
console.log(JSON.stringify([{ key: 'DB_PASSWORD', value: 'hunter2' }, { key: '_PORT', value: '5432' }]));
`);

		const result = await bitwardenProvider.resolveBulk({ token: TOKEN }, PROJECT_ID);
		expect(Object.getPrototypeOf(result)).toBeNull();
		expect(Object.entries(result)).toEqual([
			['DB_PASSWORD', 'hunter2'],
			['_PORT', '5432']
		]);
		const stateHome = await readFile(statePath, 'utf8');
		expect(existsSync(stateHome)).toBe(false);
	});

	test('validates the Project UUID before execution', async () => {
		process.env.DOCKHAND_BWS_PATH = join(testDir, 'missing-bws');
		await expect(bitwardenProvider.resolveBulk({ token: TOKEN }, 'not-a-uuid')).rejects.toThrow(
			'Bitwarden Project selector must be a valid UUID'
		);
	});

	test('rejects duplicate, invalid, dangerous, and malformed secret fields', async () => {
		const cases: Array<[unknown, string]> = [
			[
				[
					{ key: 'DUPLICATE', value: 'one' },
					{ key: 'DUPLICATE', value: 'two' }
				],
				'duplicate secret keys'
			],
			[[{ key: 'BAD-NAME', value: 'value' }], 'not a valid environment variable name'],
			[[{ key: 'constructor', value: 'value' }], 'secret key is not allowed'],
			[[{ key: 'PORT', value: 5432 }], 'invalid secret list'],
			[[{ key: 'VALUE', value: 'contains\0nul' }], 'invalid secret list'],
			[['not-an-object'], 'invalid secret list']
		];

		for (const [payload, expected] of cases) {
			await installSecretResponse(JSON.stringify(JSON.stringify(payload)));
			await expect(bitwardenProvider.resolveBulk({ token: TOKEN }, PROJECT_ID)).rejects.toThrow(
				expected
			);
		}
	});

	test('rejects malformed JSON and a non-array root', async () => {
		await installSecretResponse(JSON.stringify('{broken'));
		await expect(bitwardenProvider.resolveBulk({ token: TOKEN }, PROJECT_ID)).rejects.toThrow(
			'Bitwarden bws returned invalid JSON'
		);

		await installSecretResponse(JSON.stringify('{"key":"value"}'));
		await expect(bitwardenProvider.resolveBulk({ token: TOKEN }, PROJECT_ID)).rejects.toThrow(
			'Bitwarden bws returned an invalid JSON response'
		);
	});

	test('does not expose stderr, tokens, or secret output on process failure', async () => {
		await installFakeBws(`
process.stdout.write('secret-output');
process.stderr.write('raw stderr ${TOKEN} another-secret');
process.exit(7);
`);
		try {
			await bitwardenProvider.resolveBulk({ token: TOKEN }, PROJECT_ID);
			throw new Error('expected resolveBulk to fail');
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toBe('Bitwarden bws command failed');
			expect(message).not.toContain(TOKEN);
			expect(message).not.toContain('secret-output');
			expect(message).not.toContain('raw stderr');
		}
	});

	test('bounds stdout and terminates an oversized command', async () => {
		await installFakeBws(`
process.on('SIGTERM', () => process.exit(0));
process.stdout.write('x'.repeat(11 * 1024 * 1024));
setTimeout(() => {}, 60_000);
`);
		await expect(bitwardenProvider.resolveBulk({ token: TOKEN }, PROJECT_ID)).rejects.toThrow(
			'Bitwarden bws command exceeded the stdout limit'
		);
	});
});
