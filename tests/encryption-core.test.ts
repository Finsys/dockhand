/**
 * Core AES-256-GCM encrypt/decrypt round-trip + fail-closed behaviour.
 *
 * The existing encryption tests cover key ROTATION and the reserved-prefix
 * bypass; this file covers the crypto CORE (encrypt, decrypt, decryptStrict,
 * isEncrypted, generateKey) which had ~0 direct coverage. Deterministic because
 * we pin ENCRYPTION_KEY (base64, 32 bytes) and clear the in-memory key cache so
 * no key file is read or written.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
	encrypt,
	decrypt,
	decryptStrict,
	isEncrypted,
	generateKey,
	clearKeyCache,
} from '../src/lib/server/encryption';

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');

// Point the key loader at a scratch dir with no key file, and pin the key via
// env so getOrCreateKey() is deterministic. clearKeyCache() forces a re-read.
function useKey(key: string) {
	process.env.DATA_DIR = `/tmp/enc-core-${process.pid}-${Math.random().toString(36).slice(2)}`;
	process.env.ENCRYPTION_KEY = key;
	clearKeyCache();
}

describe('encryption core: encrypt/decrypt round-trip', () => {
	beforeEach(() => useKey(KEY_A));

	it('round-trips a value through encrypt → decrypt', () => {
		const ct = encrypt('hunter2');
		expect(ct?.startsWith('enc:v1:')).toBe(true);
		expect(decrypt(ct)).toBe('hunter2');
	});

	it('produces a DIFFERENT ciphertext each time (random IV) but the same plaintext back', () => {
		const a = encrypt('same');
		const b = encrypt('same');
		expect(a).not.toBe(b); // random IV → distinct blobs
		expect(decrypt(a)).toBe('same');
		expect(decrypt(b)).toBe('same');
	});

	it('does not double-encrypt an already-encrypted value', () => {
		const ct = encrypt('secret');
		expect(encrypt(ct)).toBe(ct);
	});

	it('encrypts a plaintext that merely STARTS with the reserved prefix (no leak)', () => {
		const tricky = encrypt('enc:v1:notreallyciphertext');
		expect(tricky).not.toBe('enc:v1:notreallyciphertext'); // was encrypted, not passed through
		expect(decrypt(tricky)).toBe('enc:v1:notreallyciphertext');
	});

	it('passes null / undefined / empty straight through', () => {
		expect(encrypt(null)).toBeNull();
		expect(encrypt(undefined)).toBeUndefined();
		expect(encrypt('')).toBe('');
		expect(decrypt(null)).toBeNull();
		expect(decrypt('')).toBe('');
	});

	it('returns non-prefixed (legacy plaintext) values unchanged on decrypt', () => {
		expect(decrypt('plain-legacy-secret')).toBe('plain-legacy-secret');
	});

	it('isEncrypted is true only for a genuine ciphertext blob', () => {
		expect(isEncrypted(encrypt('x'))).toBe(true);
		expect(isEncrypted('plain')).toBe(false);
		expect(isEncrypted('enc:v1:tooshort')).toBe(false); // prefix but not a valid blob
		expect(isEncrypted(null)).toBe(false);
	});

	it('generateKey returns a 32-byte base64 key', () => {
		expect(Buffer.from(generateKey(), 'base64').length).toBe(32);
	});
});

describe('encryption core: fail-closed on wrong key / corruption', () => {
	it('decrypt() returns the raw value on a wrong-key failure (avoids data loss)', () => {
		useKey(KEY_A);
		const ct = encrypt('secret')!;
		useKey(KEY_B); // rotate to a different key WITHOUT re-encrypting
		expect(decrypt(ct)).toBe(ct); // can't decrypt → original blob back
	});

	it('decryptStrict() THROWS on a wrong-key failure (never forwards ciphertext as the secret)', () => {
		useKey(KEY_A);
		const ct = encrypt('secret')!;
		useKey(KEY_B);
		expect(() => decryptStrict(ct)).toThrow(/Failed to decrypt/);
	});

	it('decryptStrict() still passes genuine plaintext through unchanged', () => {
		useKey(KEY_A);
		expect(decryptStrict('legacy-plaintext')).toBe('legacy-plaintext');
	});

	// M1: the ENCRYPTION_KEY rotation loop must re-encrypt secret_providers.config
	// with the new key. This reproduces exactly what migrateCredentials does to that
	// column (decrypt with the old key, re-encrypt with the new) and proves the row
	// is readable afterwards - the omission bug left it decryptable only under the
	// gone old key. (The full loop imports better-sqlite3 which bun test can't load,
	// so this exercises the crypto contract the loop relies on.)
	it('re-encrypting a provider config on rotation keeps it decryptable under the new key', () => {
		const providerConfig = JSON.stringify({ address: 'https://vault.example', token: 'hvs.SECRET' });
		useKey(KEY_A);
		const stored = encrypt(providerConfig)!; // as createSecretProvider stores it
		expect(isEncrypted(stored)).toBe(true);

		// --- rotation: decrypt under the OLD key, re-encrypt under the NEW key ---
		const plain = decryptStrict(stored); // old key still cached at this point
		useKey(KEY_B); // switch to the new key (as the rotation tx does)
		const reEncrypted = encrypt(plain)!;

		// Under the new key the re-encrypted config round-trips to the original JSON.
		expect(decryptStrict(reEncrypted)).toBe(providerConfig);

		// And the ORIGINAL blob is now undecryptable (proves it HAD to be re-encrypted).
		expect(() => decryptStrict(stored)).toThrow(/Failed to decrypt/);
	});

	it('decrypt() returns the raw value on a too-short / corrupt blob', () => {
		useKey(KEY_A);
		expect(decrypt('enc:v1:AAAA')).toBe('enc:v1:AAAA'); // decodes but < iv+tag+1
	});
});
