/**
 * Unit tests for git webhook signature verification.
 *
 * Covers every provider wire format we accept:
 * - GitHub / Gitea / Forgejo: `X-Hub-Signature-256: sha256=<hmac>` (HMAC-SHA256 of body)
 * - GitLab: `X-Gitlab-Token: <secret>` (plain token, exact match)
 *
 * Run with: bun test tests/unit/webhook-signature.test.ts
 */

import { describe, test, expect } from 'bun:test';
import crypto from 'node:crypto';
import { verifyWebhookSignature } from '../src/lib/server/webhook-signature';

const SECRET = 'super-secret-value-123';
const PAYLOAD = JSON.stringify({ ref: 'refs/heads/main', repository: { name: 'demo' } });

// The sha256= HMAC scheme, as GitHub/Gitea/Forgejo compute it.
function hmacHeader(secret: string, payload: string): string {
	return 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

describe('verifyWebhookSignature - HMAC providers (GitHub / Gitea / Forgejo)', () => {
	test('GitHub: valid sha256 HMAC passes', () => {
		expect(verifyWebhookSignature(PAYLOAD, hmacHeader(SECRET, PAYLOAD), SECRET)).toBe(true);
	});

	test('Gitea: valid sha256 HMAC passes (GitHub-compatible scheme)', () => {
		expect(verifyWebhookSignature(PAYLOAD, hmacHeader(SECRET, PAYLOAD), SECRET)).toBe(true);
	});

	test('Forgejo: valid sha256 HMAC passes (GitHub-compatible scheme)', () => {
		expect(verifyWebhookSignature(PAYLOAD, hmacHeader(SECRET, PAYLOAD), SECRET)).toBe(true);
	});

	test('HMAC computed with the wrong secret fails', () => {
		expect(verifyWebhookSignature(PAYLOAD, hmacHeader('wrong-secret', PAYLOAD), SECRET)).toBe(false);
	});

	test('HMAC over a different payload fails (body tamper)', () => {
		const sig = hmacHeader(SECRET, PAYLOAD);
		expect(verifyWebhookSignature(PAYLOAD + 'x', sig, SECRET)).toBe(false);
	});

	test('truncated sha256 signature fails (length mismatch, no throw)', () => {
		expect(verifyWebhookSignature(PAYLOAD, 'sha256=deadbeef', SECRET)).toBe(false);
	});

	test('sha256 prefix with empty digest fails', () => {
		expect(verifyWebhookSignature(PAYLOAD, 'sha256=', SECRET)).toBe(false);
	});
});

describe('verifyWebhookSignature - token provider (GitLab)', () => {
	test('GitLab: exact token match passes', () => {
		expect(verifyWebhookSignature(PAYLOAD, SECRET, SECRET)).toBe(true);
	});

	test('GitLab: wrong token fails', () => {
		expect(verifyWebhookSignature(PAYLOAD, 'not-the-secret', SECRET)).toBe(false);
	});

	test('GitLab: token differing only in length fails (no throw)', () => {
		expect(verifyWebhookSignature(PAYLOAD, SECRET + 'extra', SECRET)).toBe(false);
	});

	test('GitLab: token is compared independently of payload', () => {
		// A plain token must not depend on the body, unlike the HMAC scheme.
		expect(verifyWebhookSignature('any-other-body', SECRET, SECRET)).toBe(true);
	});
});

describe('verifyWebhookSignature - missing signature', () => {
	test('null signature fails', () => {
		expect(verifyWebhookSignature(PAYLOAD, null, SECRET)).toBe(false);
	});

	test('empty signature fails', () => {
		expect(verifyWebhookSignature(PAYLOAD, '', SECRET)).toBe(false);
	});
});
