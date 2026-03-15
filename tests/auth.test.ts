/**
 * Tests for Authentication Logic
 *
 * Tests rate limiting (in-memory state) and password hashing/verification.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import {
	isRateLimited,
	recordFailedAttempt,
	clearRateLimit,
	hashPassword,
	verifyPassword
} from '../src/lib/server/auth';

// =============================================================================
// Rate Limiting
// =============================================================================

describe('Rate Limiting', () => {
	const testId = () => `test-${Date.now()}-${Math.random()}`;

	test('unknown identifier is not rate limited', () => {
		const result = isRateLimited(testId());
		expect(result.limited).toBe(false);
		expect(result.retryAfter).toBeUndefined();
	});

	test('1-4 failed attempts are not rate limited', () => {
		const id = testId();
		for (let i = 0; i < 4; i++) {
			recordFailedAttempt(id);
		}
		const result = isRateLimited(id);
		expect(result.limited).toBe(false);
	});

	test('5 failed attempts triggers rate limiting', () => {
		const id = testId();
		for (let i = 0; i < 5; i++) {
			recordFailedAttempt(id);
		}
		const result = isRateLimited(id);
		expect(result.limited).toBe(true);
		expect(result.retryAfter).toBeGreaterThan(0);
	});

	test('clearRateLimit removes the limit', () => {
		const id = testId();
		for (let i = 0; i < 5; i++) {
			recordFailedAttempt(id);
		}
		expect(isRateLimited(id).limited).toBe(true);

		clearRateLimit(id);
		expect(isRateLimited(id).limited).toBe(false);
	});

	test('clearing non-existent identifier does not throw', () => {
		expect(() => clearRateLimit(testId())).not.toThrow();
	});

	test('different identifiers are tracked independently', () => {
		const id1 = testId();
		const id2 = testId();

		for (let i = 0; i < 5; i++) {
			recordFailedAttempt(id1);
		}

		expect(isRateLimited(id1).limited).toBe(true);
		expect(isRateLimited(id2).limited).toBe(false);
	});
});

// =============================================================================
// Password Hashing
// =============================================================================

describe('Password Hashing', () => {
	test('hashPassword returns a hash string', async () => {
		const hash = await hashPassword('test-password');
		expect(typeof hash).toBe('string');
		expect(hash.length).toBeGreaterThan(0);
		expect(hash).not.toBe('test-password');
	});

	test('verifyPassword returns true for correct password', async () => {
		const password = 'correct-password-123!';
		const hash = await hashPassword(password);
		const result = await verifyPassword(password, hash);
		expect(result).toBe(true);
	});

	test('verifyPassword returns false for wrong password', async () => {
		const hash = await hashPassword('correct-password');
		const result = await verifyPassword('wrong-password', hash);
		expect(result).toBe(false);
	});

	test('different passwords produce different hashes', async () => {
		const hash1 = await hashPassword('password-one');
		const hash2 = await hashPassword('password-two');
		expect(hash1).not.toBe(hash2);
	});

	test('same password produces different hashes (salt)', async () => {
		const hash1 = await hashPassword('same-password');
		const hash2 = await hashPassword('same-password');
		// Due to random salt, hashes should differ
		expect(hash1).not.toBe(hash2);
	});

	test('handles special characters in passwords', async () => {
		const password = 'P@$$w0rd!#%^&*()_+{}|:<>?äöü€';
		const hash = await hashPassword(password);
		const result = await verifyPassword(password, hash);
		expect(result).toBe(true);
	});

	test('handles long passwords', async () => {
		const password = 'x'.repeat(1000);
		const hash = await hashPassword(password);
		const result = await verifyPassword(password, hash);
		expect(result).toBe(true);
	});
});
