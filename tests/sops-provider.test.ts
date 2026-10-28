/**
 * SOPS secret provider (#386): a Git stack's SOPS-encrypted env file is decrypted
 * with an age identity from the provider config, and its values reach compose as
 * secrets. The pure helpers are tested directly; the provider itself runs the real
 * sops binary against a fixture encrypted for a throwaway test key, and is skipped
 * where sops is not installed.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	envFileKeys,
	isSopsCiphertext,
	isSopsDotenv,
	mergeDecryptedEnvFile,
	normalizeAgeIdentities,
	parseSopsDecryptOutput,
	sopsEncryptedKeys,
	withoutSopsArtifacts,
	envFileFormVars
} from '../src/lib/server/secretproviders/sops-core';
import { parseEnvFileForForm } from '../src/lib/utils/env-file-values';
import { gitStackEnvFileRelPath } from '../src/lib/server/git-stack-env-path';
import { redactProviderConfig, SECRET_CONFIG_KEYS } from '../src/lib/server/secretproviders/shared';

const FIXTURES = join(import.meta.dir, 'fixtures/sops');
const ENCRYPTED = readFileSync(join(FIXTURES, 'secrets.sops.env'), 'utf8');
// Throwaway identity generated for these tests only; it protects nothing else.
const TEST_KEYS_TXT = readFileSync(join(FIXTURES, 'test-age-key.txt'), 'utf8');
const TEST_IDENTITY = TEST_KEYS_TXT.match(/AGE-SECRET-KEY-1\S+/)![0];
const OTHER_IDENTITY = 'AGE-SECRET-KEY-10LADNA9FQVYADVHRT9WEAFF4ENMAAWA6AWE7JQ2XGJ4FM92FWTRSGDSC8W';

describe('isSopsDotenv', () => {
	test('recognises a file sops encrypted', () => {
		expect(isSopsDotenv(ENCRYPTED)).toBe(true);
	});

	test('a plain env file is not SOPS, so a bound SOPS provider leaves it alone', () => {
		expect(isSopsDotenv('DB_PASSWORD=s3cr3t\nAPI_KEY=abc\n')).toBe(false);
		expect(isSopsDotenv('')).toBe(false);
		expect(isSopsDotenv(undefined)).toBe(false);
	});

	test('a value that merely mentions the metadata keys is no match', () => {
		expect(isSopsDotenv('NOTE=see sops_mac= and sops_version= in the docs\n')).toBe(false);
	});
});

describe('isSopsCiphertext', () => {
	test('matches an encrypted value and nothing else', () => {
		const line = ENCRYPTED.split('\n').find((l) => l.startsWith('DB_PASSWORD='))!;
		expect(isSopsCiphertext(line.slice('DB_PASSWORD='.length))).toBe(true);
		expect(isSopsCiphertext('s3cr3t')).toBe(false);
		expect(isSopsCiphertext('ENC[not sops]')).toBe(false);
		expect(isSopsCiphertext(undefined)).toBe(false);
	});
});

describe('normalizeAgeIdentities', () => {
	test('accepts a bare identity', () => {
		expect(normalizeAgeIdentities(`  ${TEST_IDENTITY}\n`)).toBe(TEST_IDENTITY);
	});

	test('accepts a whole keys.txt, dropping its comments', () => {
		expect(normalizeAgeIdentities(TEST_KEYS_TXT)).toBe(TEST_IDENTITY);
	});

	test('accepts a keys.txt a password input collapsed onto one line', () => {
		expect(normalizeAgeIdentities(TEST_KEYS_TXT.replace(/\n/g, ' '))).toBe(TEST_IDENTITY);
	});

	test('keeps several identities, one per line, without duplicates', () => {
		const raw = `${TEST_IDENTITY}\n${OTHER_IDENTITY}\n${TEST_IDENTITY}`;
		expect(normalizeAgeIdentities(raw)).toBe(`${TEST_IDENTITY}\n${OTHER_IDENTITY}`);
	});

	test('accepts a post-quantum identity (age-keygen -pq)', () => {
		const pq = `AGE-SECRET-KEY-PQ-1${TEST_IDENTITY.slice('AGE-SECRET-KEY-1'.length)}`;
		expect(normalizeAgeIdentities(`${pq}\n${TEST_IDENTITY}`)).toBe(`${pq}\n${TEST_IDENTITY}`);
	});

	test('names a plugin identity as unsupported', () => {
		expect(() => normalizeAgeIdentities('AGE-PLUGIN-YUBIKEY-1QQQQ')).toThrow(/plugin identities/);
	});

	test('rejects input without an identity, without echoing it', () => {
		for (const raw of ['', '   ', 'age1publickeyonly', 'AGE-SECRET-KEY-1TOOSHORT', undefined, 42]) {
			let message = '';
			try {
				normalizeAgeIdentities(raw);
			} catch (e) {
				message = (e as Error).message;
			}
			expect(message).toMatch(/SOPS age key/);
			if (typeof raw === 'string' && raw.trim()) expect(message).not.toContain(raw.trim());
		}
	});
});

describe('sopsEncryptedKeys / envFileKeys', () => {
	test('lists only the keys whose value sops encrypted, export prefix and metadata aside', () => {
		// Not EMPTY (sops leaves an empty value as is), PUBLIC_unencrypted (left in the
		// clear by the suffix) or BAD-KEY (no env-var name).
		expect([...sopsEncryptedKeys(ENCRYPTED)].sort()).toEqual(
			['COMMENTED', 'DB_PASSWORD', 'ESCAPED', 'EXPORTED', 'NEWLINE', 'QUOTED', 'REF', 'SINGLE', 'WINPATH']
		);
	});

	test('reads the names a plain env file defines', () => {
		expect([...envFileKeys('# c\nA=1\nexport B=2\n  C = 3\nnot a line\n')]).toEqual(['A', 'B', 'C']);
		expect(envFileKeys(undefined).size).toBe(0);
	});
});

describe('withoutSopsArtifacts', () => {
	test('drops the sops_* metadata and values still encrypted', () => {
		expect(
			withoutSopsArtifacts({ A: 'ENC[AES256_GCM,data:x,iv:y,tag:z,type:str]', sops_mac: 'm', sops_version: '3', PLAIN: 'p' })
		).toEqual({ PLAIN: 'p' });
	});
});

describe('parseSopsDecryptOutput', () => {
	const all = (keys: string[]) => new Set(keys);

	test('reads values the way compose reads an env file', () => {
		const { vars } = parseSopsDecryptOutput(
			[
				'# a comment',
				'A="with spaces"',
				"B='single $A'",
				'C="mismatched\'',
				'D=""',
				'E=value # comment',
				'F=${A}-x',
				String.raw`G="esc \" q"`,
				'export H=h',
				''
			].join('\n'),
			all(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'])
		);
		expect(vars).toEqual({
			A: 'with spaces',
			B: 'single $A',
			C: '"mismatched\'',
			D: '',
			E: 'value',
			F: 'with spaces-x',
			G: 'esc " q',
			H: 'h'
		});
	});

	test('a backslash escape is read only inside double quotes, as compose does', () => {
		const { vars } = parseSopsDecryptOutput(
			[String.raw`A=C:\new\dir`, String.raw`B='x\ny'`, String.raw`C="x\ny"`, String.raw`D=a\\b`, String.raw`E="a\\b"`].join('\n'),
			all(['A', 'B', 'C', 'D', 'E'])
		);
		expect(vars).toEqual({
			A: String.raw`C:\new\dir`,
			B: String.raw`x\ny`,
			C: 'x\ny',
			D: String.raw`a\\b`,
			E: String.raw`a\b`
		});
	});

	test('returns only encrypted keys, but lets later lines refer to the rest', () => {
		const { vars } = parseSopsDecryptOutput('HOST_unencrypted=db\nURL=postgres://${HOST_unencrypted}\n', all(['URL']));
		expect(vars).toEqual({ URL: 'postgres://db' });
	});

	test('skips lines whose key is not an env-var name, reporting the name only', () => {
		const { vars, skipped } = parseSopsDecryptOutput(
			'GOOD=x\nBAD-KEY=secret-value\n__proto__x=y\n__proto__=z\n',
			all(['GOOD', 'BAD-KEY', '__proto__x', '__proto__'])
		);
		expect(vars).toEqual({ GOOD: 'x', __proto__x: 'y' });
		expect(Object.getPrototypeOf(vars)).toBeNull();
		expect(skipped).toEqual(['BAD-KEY', '__proto__']);
	});
});

describe('mergeDecryptedEnvFile', () => {
	test('decrypted values become secrets underneath DB secrets and DB overrides', () => {
		const dbNonSecretVars = { LOG_LEVEL: 'debug', API_URL: 'https://override' };
		const secretVars = { DB_PASSWORD: 'explicit-db-secret' };
		const injected = mergeDecryptedEnvFile(
			{ DB_PASSWORD: 'from-file', API_URL: 'https://from-file', TOKEN: 't0k3n' },
			dbNonSecretVars,
			secretVars
		);
		expect(injected).toBe(1);
		expect(secretVars).toEqual({ DB_PASSWORD: 'explicit-db-secret', TOKEN: 't0k3n' });
		expect(dbNonSecretVars).toEqual({ LOG_LEVEL: 'debug', API_URL: 'https://override' });
	});

	test('names that exist on Object.prototype are injected like any other', () => {
		const secretVars: Record<string, string> = {};
		mergeDecryptedEnvFile({ toString: 'a', valueOf: 'b' }, {}, secretVars);
		expect(secretVars).toEqual({ toString: 'a', valueOf: 'b' });
	});

});

describe('gitStackEnvFileRelPath', () => {
	test('resolves relative to the compose directory', () => {
		expect(gitStackEnvFileRelPath({ composePath: 'compose.yaml', envFilePath: 'secrets.sops.env' })).toBe('secrets.sops.env');
		expect(gitStackEnvFileRelPath({ composePath: 'stacks/app/compose.yaml', envFilePath: 'stacks/app/secrets.sops.env' })).toBe('secrets.sops.env');
		expect(gitStackEnvFileRelPath({ composePath: './stacks/app/compose.yaml', envFilePath: 'stacks/app/env/prod.sops.env' })).toBe('env/prod.sops.env');
	});

	test('resolves relative to the context directory when one is set', () => {
		expect(
			gitStackEnvFileRelPath({ composePath: 'apps/web/compose.yaml', contextDir: 'apps', envFilePath: 'apps/shared.sops.env' })
		).toBe('shared.sops.env');
	});

	test('is null when nothing is configured or the file is not copied into the stack dir', () => {
		expect(gitStackEnvFileRelPath({ composePath: 'compose.yaml', envFilePath: null })).toBeNull();
		expect(gitStackEnvFileRelPath({ composePath: 'compose.yaml', envFilePath: '  ' })).toBeNull();
		expect(gitStackEnvFileRelPath({ composePath: 'stacks/app/compose.yaml', envFilePath: 'secrets.sops.env' })).toBeNull();
		expect(gitStackEnvFileRelPath({ composePath: 'stacks/app/compose.yaml', envFilePath: 'stacks/app' })).toBeNull();
		expect(gitStackEnvFileRelPath({ composePath: null, envFilePath: 'secrets.sops.env' })).toBeNull();
	});
});

describe('SOPS provider config', () => {
	test('the age key is a secret: never sent back to the edit form', () => {
		expect(SECRET_CONFIG_KEYS.has('ageKey')).toBe(true);
		expect(redactProviderConfig({ ageKey: TEST_IDENTITY })).toEqual({});
	});
});

const sopsPath = Bun.which('sops');

describe.skipIf(!sopsPath)('SOPS provider (real sops binary)', () => {
	process.env.DOCKHAND_SOPS_PATH = sopsPath ?? '';

	test('is registered', async () => {
		const { getProvider } = await import('../src/lib/server/secretproviders');
		const provider = getProvider('sops');
		expect(provider?.label).toBe('SOPS (age)');
		expect(provider?.decryptEnvFile).toBeFunction();
	});

	test('decrypts the env file with a recipient key', async () => {
		const { sopsProvider } = await import('../src/lib/server/secretproviders/sops');
		const vars = await sopsProvider.decryptEnvFile!({ ageKey: TEST_KEYS_TXT }, ENCRYPTED);
		// EMPTY and PUBLIC_unencrypted are not encrypted (compose reads them from the
		// file); BAD-KEY is no env-var name.
		expect(vars).toEqual({
			DB_PASSWORD: 's3cr3t',
			QUOTED: 'with spaces',
			EXPORTED: 'e1',
			COMMENTED: 'value',
			REF: 's3cr3t-x',
			ESCAPED: 'a " b',
			SINGLE: '$DB_PASSWORD',
			WINPATH: String.raw`C:\new\dir`,
			NEWLINE: 'x\ny'
		});
	});

	test('fails, rather than deploying ciphertext, when no key is a recipient', async () => {
		const { sopsProvider } = await import('../src/lib/server/secretproviders/sops');
		await expect(sopsProvider.decryptEnvFile!({ ageKey: OTHER_IDENTITY }, ENCRYPTED)).rejects.toThrow(/none of the configured age keys/);
	});

	test('fails on content sops cannot read', async () => {
		const { sopsProvider } = await import('../src/lib/server/secretproviders/sops');
		await expect(sopsProvider.decryptEnvFile!({ ageKey: TEST_IDENTITY }, 'A=b\n')).rejects.toThrow(/not be valid SOPS dotenv/);
	});

	test('testConnection checks the key shape and the executable', async () => {
		const { sopsProvider } = await import('../src/lib/server/secretproviders/sops');
		expect(await sopsProvider.testConnection({ ageKey: TEST_IDENTITY })).toEqual({ ok: true });
		const bad = await sopsProvider.testConnection({ ageKey: 'nope' });
		expect(bad.ok).toBe(false);
		expect(bad.error).toMatch(/AGE-SECRET-KEY-\.\.\./);
	});
});

// The stack editor shows a SOPS file's own variables, never its sops_* metadata.
describe('envFileFormVars', () => {
	const METADATA = ['sops_age__list_0__map_enc', 'sops_age__list_0__map_recipient', 'sops_lastmodified', 'sops_mac', 'sops_unencrypted_suffix', 'sops_version'];

	test('a SOPS file loses exactly its sops_* metadata', () => {
		const all = Object.fromEntries(parseEnvFileForForm(ENCRYPTED).map((r) => [r.key, r.value]));
		const shown = envFileFormVars(ENCRYPTED);
		expect(Object.keys(all).filter((k) => !(k in shown)).sort()).toEqual(METADATA);
		for (const key of Object.keys(shown)) expect(shown[key]).toBe(all[key]);
	});

	test('the encrypted variables and the unencrypted one stay, under their names', () => {
		const shown = envFileFormVars(ENCRYPTED);
		expect(shown.DB_PASSWORD).toStartWith('ENC[AES256_GCM,');
		expect(shown.PUBLIC_unencrypted).toBe('visible');
	});

	test('a plain env file keeps a variable of its own that starts with sops_', () => {
		expect(envFileFormVars('sops_mode=strict\nAPP=1\n')).toEqual({ sops_mode: 'strict', APP: '1' });
	});
});
