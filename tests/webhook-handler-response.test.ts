import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RequestEvent } from '@sveltejs/kit';
import { handleGitWebhookRequest, type GitWebhookEntity, type GitWebhookHandlerOptions } from '../src/lib/server/git-webhook-handler';

function eventFor(secret: string): RequestEvent {
	const url = new URL(`https://example.test/webhook/1?secret=${secret}`);
	return {
		params: { id: '1' },
		request: new Request(url, { method: 'GET' }),
		url
	} as unknown as RequestEvent;
}

function optionsFor(entity: GitWebhookEntity, trigger: () => Promise<{ success: boolean; skipped?: boolean }>, audits: string[], synchronous = false): GitWebhookHandlerOptions<GitWebhookEntity> {
	return {
		load: async () => entity,
		audit: async (_event, _id, _entity, meta) => { audits.push(meta.result ?? meta.error ?? ''); },
		trigger,
		invalidIdMessage: 'invalid',
		notFoundMessage: 'not found',
		webhookDisabledMessage: 'disabled',
		secretNotConfiguredMessage: 'no secret',
		successMessage: 'ok',
		synchronous
	};
}

const enabled: GitWebhookEntity = { webhookEnabled: true, webhookSecret: 's3cret' };

describe('webhook handler response + audit', () => {
	it('synchronous skipped returns 200 with the result and audits skipped', async () => {
		const audits: string[] = [];
		const res = await handleGitWebhookRequest(eventFor('s3cret'), optionsFor(enabled, async () => ({ success: true, skipped: true }), audits, true));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { success: true, skipped: true });
		assert.deepEqual(audits, ['skipped']);
	});

	it('synchronous failure returns 200 with the result and audits failed', async () => {
		const audits: string[] = [];
		const res = await handleGitWebhookRequest(eventFor('s3cret'), optionsFor(enabled, async () => ({ success: false }), audits, true));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { success: false });
		assert.deepEqual(audits, ['failed']);
	});

	it('synchronous success returns 200 with the result and audits deployed', async () => {
		const audits: string[] = [];
		const res = await handleGitWebhookRequest(eventFor('s3cret'), optionsFor(enabled, async () => ({ success: true, skipped: false }), audits, true));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { success: true, skipped: false });
		assert.deepEqual(audits, ['deployed']);
	});

	it('background success returns 202 and audits triggered', async () => {
		const audits: string[] = [];
		const res = await handleGitWebhookRequest(eventFor('s3cret'), optionsFor(enabled, async () => ({ success: true }), audits, false));
		assert.equal(res.status, 202);
		assert.deepEqual(audits, ['triggered']);
	});

	it('background failure returns 500 and audits failed', async () => {
		const audits: string[] = [];
		const res = await handleGitWebhookRequest(eventFor('s3cret'), optionsFor(enabled, async () => ({ success: false, error: 'boom' }), audits, false));
		assert.equal(res.status, 500);
		assert.deepEqual(await res.json(), { success: false, error: 'boom' });
		assert.deepEqual(audits, ['failed']);
	});
});
