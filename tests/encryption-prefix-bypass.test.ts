/**
 * Regression test for audit LOW #1/#40: a secret that literally starts with the
 * reserved "enc:v1:" prefix was passed through encrypt() unchanged and stored as
 * PLAINTEXT. encrypt() now only skips re-encrypting values that are genuinely our
 * ciphertext (valid prefix AND a decodable, long-enough payload).
 */
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

import { encrypt, decrypt, looksLikeCiphertext } from '../src/lib/server/encryption';

before(() => {
	// Deterministic key so encrypt/decrypt round-trip in the test env.
	process.env.ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
});

describe('encryption reserved-prefix bypass (audit #1/#40)', () => {
	it('encrypts a password that starts with the reserved prefix (no plaintext leak)', () => {
		const pw = 'enc:v1:hunter2';
		const enc = encrypt(pw)!;
		assert.notEqual(enc, pw, 'must not store the prefixed password verbatim');
		assert.equal(decrypt(enc), pw, 'must round-trip back to the original');
	});

	it('looksLikeCiphertext is false for a plaintext that merely starts with the prefix', () => {
		assert.equal(looksLikeCiphertext('enc:v1:hunter2'), false);
		assert.equal(looksLikeCiphertext('enc:v1:'), false);
		assert.equal(looksLikeCiphertext('enc:v1:!!!not-base64!!!'), false);
	});

	it('looksLikeCiphertext is true for a real encrypted blob, and it is not double-encrypted', () => {
		const enc = encrypt('some-secret')!;
		assert.equal(looksLikeCiphertext(enc), true);
		assert.equal(encrypt(enc), enc, 'genuine ciphertext must not be re-encrypted');
	});

	it('normal passwords still round-trip', () => {
		const n = 'S3cr3t-P@ss';
		assert.equal(decrypt(encrypt(n)!), n);
	});
});
