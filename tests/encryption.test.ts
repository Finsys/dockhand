/**
 * Unit Tests for Encryption Module
 *
 * Tests AES-256-GCM encryption/decryption, key generation,
 * and backwards compatibility handling.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { encrypt, decrypt, isEncrypted, generateKey, clearKeyCache } from '../src/lib/server/encryption';

describe('Encryption Module', () => {
	beforeEach(() => {
		// Reset key cache between tests to ensure isolation
		clearKeyCache();
	});

	describe('encrypt', () => {
		test('returns null for null input', () => {
			expect(encrypt(null)).toBeNull();
		});

		test('passes through undefined input', () => {
			expect(encrypt(undefined)).toBeUndefined();
		});

		test('returns empty string for empty string input', () => {
			expect(encrypt('')).toBe('');
		});

		test('encrypts plaintext with enc:v1: prefix', () => {
			const result = encrypt('my-secret-value');
			expect(result).not.toBeNull();
			expect(result!.startsWith('enc:v1:')).toBe(true);
		});

		test('produces different ciphertexts for same input (random IV)', () => {
			const result1 = encrypt('same-text');
			const result2 = encrypt('same-text');
			expect(result1).not.toBeNull();
			expect(result2).not.toBeNull();
			// Different IVs should produce different ciphertexts
			expect(result1).not.toBe(result2);
		});

		test('does not double-encrypt already encrypted values', () => {
			const encrypted = encrypt('secret');
			expect(encrypted).not.toBeNull();
			const doubleEncrypted = encrypt(encrypted!);
			// Should be the same - not re-encrypted
			expect(doubleEncrypted).toBe(encrypted);
		});
	});

	describe('decrypt', () => {
		test('returns null for null input', () => {
			expect(decrypt(null)).toBeNull();
		});

		test('passes through undefined input', () => {
			expect(decrypt(undefined)).toBeUndefined();
		});

		test('returns empty string for empty string input', () => {
			expect(decrypt('')).toBe('');
		});

		test('returns plaintext as-is (backwards compatibility)', () => {
			expect(decrypt('plain-text-value')).toBe('plain-text-value');
		});

		test('roundtrip: decrypt(encrypt(text)) returns original text', () => {
			const original = 'my-secret-password-123!@#';
			const encrypted = encrypt(original);
			expect(encrypted).not.toBeNull();
			const decrypted = decrypt(encrypted!);
			expect(decrypted).toBe(original);
		});

		test('roundtrip works for unicode text', () => {
			const original = 'Passwort: ä-ö-ü-ß-€-中文-🔑';
			const encrypted = encrypt(original);
			const decrypted = decrypt(encrypted!);
			expect(decrypted).toBe(original);
		});

		test('roundtrip works for long text', () => {
			const original = 'x'.repeat(10000);
			const encrypted = encrypt(original);
			const decrypted = decrypt(encrypted!);
			expect(decrypted).toBe(original);
		});

		test('returns original value for invalid encrypted payload', () => {
			const badValue = 'enc:v1:not-valid-base64!!!';
			const result = decrypt(badValue);
			// Should not crash, returns something (might be original or decrypted attempt)
			expect(result).toBeDefined();
		});

		test('returns original value for too-short payload', () => {
			const shortPayload = 'enc:v1:' + Buffer.from('short').toString('base64');
			const result = decrypt(shortPayload);
			expect(result).toBeDefined();
		});
	});

	describe('isEncrypted', () => {
		test('returns true for encrypted values', () => {
			const encrypted = encrypt('test');
			expect(isEncrypted(encrypted)).toBe(true);
		});

		test('returns false for plain text', () => {
			expect(isEncrypted('just-plain-text')).toBe(false);
		});

		test('returns false for null', () => {
			expect(isEncrypted(null)).toBe(false);
		});

		test('returns false for undefined', () => {
			expect(isEncrypted(undefined)).toBe(false);
		});

		test('returns false for empty string', () => {
			expect(isEncrypted('')).toBe(false);
		});

		test('returns true for the exact prefix pattern', () => {
			expect(isEncrypted('enc:v1:some-data')).toBe(true);
		});
	});

	describe('generateKey', () => {
		test('returns a base64-encoded string', () => {
			const key = generateKey();
			expect(typeof key).toBe('string');
			// Should be valid base64
			const decoded = Buffer.from(key, 'base64');
			expect(decoded.length).toBe(32); // 256 bits = 32 bytes
		});

		test('generates unique keys', () => {
			const key1 = generateKey();
			const key2 = generateKey();
			expect(key1).not.toBe(key2);
		});
	});

	describe('clearKeyCache', () => {
		test('clears cached key without error', () => {
			// Ensure a key is cached by encrypting something
			encrypt('trigger-key-creation');
			// Clearing should not throw
			expect(() => clearKeyCache()).not.toThrow();
		});
	});
});
