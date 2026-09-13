// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, test, expect, afterEach } from 'bun:test';
import { decideWebhookSecretPolicy, allowSecretlessWebhook, webhookConfigRequiresSecret } from '../../src/lib/server/webhook-secret-policy';

// This proves the pure policy (all 4 combinations) + the env-flag parsing. The webhook
// handler is a thin wiring of decideWebhookSecretPolicy; the deploy-unverified branch
// (ALLOW_WEBHOOKS_WITHOUT_SECRET=true) needs the server booted with that env, which the
// shared CI instances do not set, so it is verified manually on a dedicated instance.

describe('decideWebhookSecretPolicy', () => {
	test('a configured secret is always verified (opt-out off)', () => {
		expect(decideWebhookSecretPolicy(true, false)).toEqual({ action: 'verify' });
	});

	test('a configured secret is verified even when the opt-out is on', () => {
		// the opt-out must NOT weaken a webhook that has a secret
		expect(decideWebhookSecretPolicy(true, true)).toEqual({ action: 'verify' });
	});

	test('no secret and no opt-out is rejected (secure default)', () => {
		expect(decideWebhookSecretPolicy(false, false)).toEqual({ action: 'reject-no-secret' });
	});

	test('no secret with the opt-out on deploys unverified', () => {
		expect(decideWebhookSecretPolicy(false, true)).toEqual({ action: 'deploy-unverified' });
	});
});

describe('webhookConfigRequiresSecret (create/update gate)', () => {
	test('enabled + no secret + no opt-out -> must reject (secure default)', () => {
		expect(webhookConfigRequiresSecret(true, false, false)).toBe(true);
	});
	test('enabled + no secret + opt-out on -> allowed (the escape hatch that was unreachable)', () => {
		expect(webhookConfigRequiresSecret(true, false, true)).toBe(false);
	});
	test('enabled + secret present -> allowed regardless of opt-out', () => {
		expect(webhookConfigRequiresSecret(true, true, false)).toBe(false);
		expect(webhookConfigRequiresSecret(true, true, true)).toBe(false);
	});
	test('webhook disabled -> never requires a secret', () => {
		expect(webhookConfigRequiresSecret(false, false, false)).toBe(false);
		expect(webhookConfigRequiresSecret(false, false, true)).toBe(false);
	});
});

describe('allowSecretlessWebhook (env flag)', () => {
	const original = process.env.ALLOW_WEBHOOKS_WITHOUT_SECRET;
	afterEach(() => {
		if (original === undefined) delete process.env.ALLOW_WEBHOOKS_WITHOUT_SECRET;
		else process.env.ALLOW_WEBHOOKS_WITHOUT_SECRET = original;
	});

	test('off by default (unset)', () => {
		delete process.env.ALLOW_WEBHOOKS_WITHOUT_SECRET;
		expect(allowSecretlessWebhook()).toBe(false);
	});

	test('only the exact string "true" enables it', () => {
		process.env.ALLOW_WEBHOOKS_WITHOUT_SECRET = 'true';
		expect(allowSecretlessWebhook()).toBe(true);
		for (const v of ['1', 'TRUE', 'yes', 'on', '']) {
			process.env.ALLOW_WEBHOOKS_WITHOUT_SECRET = v;
			expect(allowSecretlessWebhook()).toBe(false);
		}
	});
});
