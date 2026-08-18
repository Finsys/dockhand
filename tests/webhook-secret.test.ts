import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	WEBHOOK_SECRET_REQUIRED_ERROR,
	ensureWebhookSecret,
	generateWebhookSecret,
	webhookSecretValidationError
} from '../src/lib/utils/webhook-secret';

describe('generateWebhookSecret', () => {
	it('generates a hex secret of 2 * byteLength characters', () => {
		const secret = generateWebhookSecret();
		assert.match(secret, /^[0-9a-f]+$/);
		assert.equal(secret.length, 64);
	});

	it('honors a custom byte length', () => {
		assert.equal(generateWebhookSecret(16).length, 32);
	});

	it('generates a different secret on every call', () => {
		assert.notEqual(generateWebhookSecret(), generateWebhookSecret());
	});
});

describe('webhookSecretValidationError', () => {
	it('returns an error when the webhook is enabled without a secret', () => {
		assert.equal(webhookSecretValidationError(true, null), WEBHOOK_SECRET_REQUIRED_ERROR);
		assert.equal(webhookSecretValidationError(true, ''), WEBHOOK_SECRET_REQUIRED_ERROR);
		assert.equal(webhookSecretValidationError(true, '   '), WEBHOOK_SECRET_REQUIRED_ERROR);
	});

	it('accepts a configured secret', () => {
		assert.equal(webhookSecretValidationError(true, 's3cret'), undefined);
	});

	it('does not require a secret when the webhook is disabled', () => {
		assert.equal(webhookSecretValidationError(false, null), undefined);
	});
});

describe('ensureWebhookSecret', () => {
	it('generates a secret when the webhook is enabled without one', () => {
		const secret = ensureWebhookSecret(true, '');
		assert.match(secret, /^[0-9a-f]{64}$/);
	});

	it('keeps an existing secret untouched', () => {
		assert.equal(ensureWebhookSecret(true, 'existing'), 'existing');
	});

	it('does nothing when the webhook is disabled', () => {
		assert.equal(ensureWebhookSecret(false, ''), '');
		assert.equal(ensureWebhookSecret(false, 'existing'), 'existing');
	});
});
