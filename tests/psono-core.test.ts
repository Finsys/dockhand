// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, expect, test } from 'bun:test';
import { xsalsa20poly1305 } from '@noble/ciphers/salsa.js';
import {
	decryptSecret,
	secretToEnvVar,
	toEnvVarName,
	isPsonoReference,
	parsePsonoReference,
	referenceValue,
	keyPermissionWarning,
	inspectedSecretIds
} from '../src/lib/server/secretproviders/psono-core';

// The two-step decryption is exercised against a payload sealed EXACTLY the way
// Psono seals one (content key sealed as hex TEXT under the api key secret, content
// sealed under that key). Verified against a real Psono CE 7.5.0 response by
// integration/secret-provider-psono-integration.test.ts, which talks to the live
// server; no real key material is committed here, so this file carries nothing for a
// scanner to flag.

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** Seals a payload the way Psono does, so a test can build its own fixture. */
function seal(content: unknown, apiKeySecret: string) {
	const contentKey = new Uint8Array(32).fill(7);
	const dataNonce = new Uint8Array(24).fill(1);
	const keyNonce = new Uint8Array(24).fill(2);
	const plain = new TextEncoder().encode(JSON.stringify(content));
	const data = xsalsa20poly1305(contentKey, dataNonce).encrypt(plain);
	// Psono seals the content key as HEX TEXT, not as raw bytes.
	const keyText = new TextEncoder().encode(hex(contentKey));
	const apiKey = Uint8Array.from(Buffer.from(apiKeySecret, 'hex'));
	const secretKey = xsalsa20poly1305(apiKey, keyNonce).encrypt(keyText);
	return {
		data: hex(data),
		data_nonce: hex(dataNonce),
		secret_key: hex(secretKey),
		secret_key_nonce: hex(keyNonce)
	};
}

const API_KEY = 'a'.repeat(64);

describe('decryptSecret', () => {
	test('decrypts the shape Psono returns, fields and all', () => {
		// The application_password_* shape a seeded Psono secret actually carries; the
		// live-server equivalent of this assertion lives in the integration test.
		const sealed = seal(
			{
				application_password_title: 'dockhand-test',
				application_password_username: 'DB_PASSWORD',
				application_password_password: 'psono-secret-value-42'
			},
			API_KEY
		);
		const out = decryptSecret(sealed, API_KEY) as Record<string, string>;
		expect(out.application_password_username).toBe('DB_PASSWORD');
		expect(out.application_password_password).toBe('psono-secret-value-42');
	});

	test('decrypts a locally sealed secret', () => {
		const sealed = seal({ note_notes: 'hello' }, API_KEY);
		expect(decryptSecret(sealed, API_KEY)).toEqual({ note_notes: 'hello' });
	});

	test('a wrong API key secret fails with an actionable message', () => {
		const sealed = seal({ note_notes: 'hello' }, API_KEY);
		expect(() => decryptSecret(sealed, 'b'.repeat(64))).toThrow(/check the API key secret/);
	});

	test('a tampered payload is rejected, not returned', () => {
		// Poly1305 authentication is what makes this detectable at all.
		const sealed = seal({ note_notes: 'hello' }, API_KEY);
		const flipped = sealed.data.slice(0, -2) + (sealed.data.endsWith('00') ? '01' : '00');
		expect(() => decryptSecret({ ...sealed, data: flipped }, API_KEY)).toThrow(/decrypt/);
	});

	test('malformed hex is named rather than passed to the cipher', () => {
		const sealed = seal({ a: 'b' }, API_KEY);
		expect(() => decryptSecret({ ...sealed, data: 'xyz' }, API_KEY)).toThrow(/not valid hex/);
		expect(() => decryptSecret({ ...sealed, data: 'abc' }, API_KEY)).toThrow(/not valid hex/);
		expect(() => decryptSecret(sealed, 'short')).toThrow(/not valid hex|32 bytes/);
	});

	test('a key of the wrong length is rejected before decrypting', () => {
		const sealed = seal({ a: 'b' }, API_KEY);
		expect(() => decryptSecret(sealed, 'ab')).toThrow(/32 bytes/);
	});
});

describe('secretToEnvVar', () => {
	test('prefers the username as the name, since that is where an env var name goes', () => {
		expect(
			secretToEnvVar({
				application_password_title: 'Prod DB',
				application_password_username: 'DB_PASSWORD',
				application_password_password: 'hunter2'
			})
		).toEqual({ name: 'DB_PASSWORD', value: 'hunter2' });
	});

	test('falls back to the title when there is no username', () => {
		expect(secretToEnvVar({ note_title: 'api token', note_notes: 'tok' })).toEqual({
			name: 'API_TOKEN',
			value: 'tok'
		});
	});

	test('a secret with no value field is skipped, not exported empty', () => {
		expect(secretToEnvVar({ note_title: 'empty' })).toBe(null);
		expect(secretToEnvVar({ website_password_title: 't', website_password_password: '' })).toBe(null);
	});

	test('a secret with no usable name is skipped', () => {
		expect(secretToEnvVar({ note_notes: 'value but nameless' })).toBe(null);
		expect(secretToEnvVar({ note_title: '!!!', note_notes: 'v' })).toBe(null);
	});

	test('non-objects are rejected', () => {
		for (const bad of [null, undefined, 'str', 42, [], [{ a: 1 }]]) {
			expect(secretToEnvVar(bad)).toBe(null);
		}
	});
});

describe('toEnvVarName', () => {
	test('a free-text title becomes assignable', () => {
		expect(toEnvVarName('Prod DB password')).toBe('PROD_DB_PASSWORD');
		expect(toEnvVarName('  api-key (live)  ')).toBe('API_KEY_LIVE');
	});

	test('a leading digit is prefixed, because 2FA=x is not assignable', () => {
		expect(toEnvVarName('2fa seed')).toBe('_2FA_SEED');
	});

	test('a title with nothing usable yields null', () => {
		expect(toEnvVarName('!!!')).toBe(null);
		expect(toEnvVarName('   ')).toBe(null);
		expect(toEnvVarName('')).toBe(null);
	});
});

describe('the psono:// reference syntax', () => {
	const ID = '552f5ea3-c8a9-4448-b98d-3bc7e41e16a4';

	test('an id alone, and an id with a field, both parse', () => {
		expect(parsePsonoReference(`psono://${ID}`)).toEqual({ secretId: ID, field: null });
		expect(parsePsonoReference(`psono://${ID}/note_notes`)).toEqual({
			secretId: ID,
			field: 'note_notes'
		});
	});

	test('the scheme is case-insensitive and surrounding space is ignored', () => {
		expect(parsePsonoReference(`  PSONO://${ID}  `)).toEqual({ secretId: ID, field: null });
	});

	test('a non-UUID id is refused rather than sent to the server', () => {
		// The server answers a bad id with a deliberately ambiguous error, so a typo
		// would look like a permission problem.
		expect(parsePsonoReference('psono://not-a-uuid')).toBe(null);
		expect(parsePsonoReference('psono://')).toBe(null);
		expect(parsePsonoReference(`psono://${ID.slice(0, -1)}`)).toBe(null);
	});

	test('another provider\'s scheme is not claimed', () => {
		expect(isPsonoReference('op://vault/item/field')).toBe(false);
		expect(isPsonoReference('pass://vault/item/field')).toBe(false);
		expect(isPsonoReference('keepass://group/entry')).toBe(false);
		expect(isPsonoReference('plain-value')).toBe(false);
		expect(isPsonoReference(42)).toBe(false);
		expect(isPsonoReference(null)).toBe(false);
	});

	test('a quoted reference resolves like a bare one', () => {
		// compose and .env routinely quote values; the quotes are the file's syntax, so
		// a quoted ref must not deploy as a literal string.
		expect(parsePsonoReference(`"psono://${ID}"`)).toEqual({ secretId: ID, field: null });
		expect(parsePsonoReference(`'psono://${ID}/note_notes'`)).toEqual({
			secretId: ID,
			field: 'note_notes'
		});
		expect(isPsonoReference(`"psono://${ID}"`)).toBe(true);
		// A lone or mismatched quote is not a quoted ref.
		expect(parsePsonoReference(`"psono://${ID}`)).toBe(null);
	});

	test('a nested path is refused - a secret has fields, not a tree', () => {
		expect(parsePsonoReference(`psono://${ID}/a/b`)).toBe(null);
		expect(parsePsonoReference(`psono://${ID}/`)).toBe(null);
	});
});

describe('referenceValue', () => {
	test('a named field is read verbatim', () => {
		expect(referenceValue({ note_notes: 'n', other: 'o' }, 'other')).toBe('o');
	});

	test('no field falls back to the type\'s value field', () => {
		expect(referenceValue({ website_password_password: 'pw' }, null)).toBe('pw');
	});

	test('a missing or non-string field yields null', () => {
		expect(referenceValue({ a: 'b' }, 'zzz')).toBe(null);
		expect(referenceValue({ a: 5 }, 'a')).toBe(null);
		expect(referenceValue(null, 'a')).toBe(null);
	});
});

describe('keyPermissionWarning', () => {
	test('a restricted read-only key is accepted silently', () => {
		expect(
			keyPermissionWarning({
				read: true,
				write: false,
				restrict_to_secrets: true,
				allow_insecure_access: false
			})
		).toBe(null);
	});

	test('insecure access is called out, since it would send the key to the server', () => {
		expect(keyPermissionWarning({ read: true, allow_insecure_access: true })).toMatch(
			/insecure access/i
		);
	});

	test('a key that cannot read is the first thing reported', () => {
		expect(keyPermissionWarning({ read: false, allow_insecure_access: true })).toMatch(
			/cannot read/i
		);
	});

	test('write access and an unrestricted key are flagged as over-privileged', () => {
		expect(keyPermissionWarning({ read: true, write: true })).toMatch(/only reads/i);
		expect(keyPermissionWarning({ read: true, restrict_to_secrets: false })).toMatch(
			/whole vault/i
		);
	});
});

describe('inspectedSecretIds', () => {
	const ID = '552f5ea3-c8a9-4448-b98d-3bc7e41e16a4';
	const ID2 = '6667a5f2-4f48-4f52-b034-bc3344ba0342';

	test('ids are returned de-duplicated', () => {
		expect(
			inspectedSecretIds({ api_key_secrets: [{ secret_id: ID }, { secret_id: ID }, { secret_id: ID2 }] })
		).toEqual([ID, ID2]);
	});

	test('a malformed id is dropped rather than requested', () => {
		expect(
			inspectedSecretIds({ api_key_secrets: [{ secret_id: 'nope' }, { secret_id: ID }] })
		).toEqual([ID]);
	});

	test('an absent or empty list is empty, not an error', () => {
		expect(inspectedSecretIds({})).toEqual([]);
		expect(inspectedSecretIds({ api_key_secrets: [] })).toEqual([]);
	});
});
