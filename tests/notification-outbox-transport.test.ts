import { describe, test, expect, afterEach } from 'bun:test';
import { sendStoredGenericWebhook } from '../src/lib/server/notifications/generic-webhook';

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
const ids = { eventId: '6bc261ef-989a-4150-a5ed-8ee796e9badb', id: '5950ddcf-6ca7-46d7-82ad-6147940affce' };
const body = JSON.stringify({ timestamp: '2026-11-10T12:00:00Z', eventId: ids.eventId, deliveryId: ids.id, title: 'Event' });

describe('queued JSON webhook transport', () => {
	test('sends stable IDs, exact stored bytes and Basic credentials in headers', async () => {
		let captured: any;
		globalThis.fetch = (async (url: unknown, request: RequestInit) => { captured = { url, request }; return new Response('', { status: 202 }); }) as any;
		const result = await sendStoredGenericWebhook('jsons://user:secret@receiver.example.org/path?secret=token', body, ids, AbortSignal.timeout(1000));
		expect(result.success).toBe(true); expect(captured.url).toBe('https://receiver.example.org/path?secret=token');
		expect(captured.request.body).toBe(body); expect(captured.request.redirect).toBe('manual');
		expect(captured.request.headers['X-Dockhand-Event-Id']).toBe(ids.eventId);
		expect(captured.request.headers['X-Dockhand-Delivery-Id']).toBe(ids.id);
		expect(captured.request.headers.Authorization).toBe('Basic '+Buffer.from('user:secret').toString('base64'));
	});

	test('classifies HTTP errors without retaining secret response bodies or destination URLs', async () => {
		for (const [status, retryable] of [[408, true], [429, true], [503, true], [401, false], [404, false]] as const) {
			globalThis.fetch = (async () => new Response('secret-provider-body', { status, headers: { 'Retry-After': '37' } })) as any;
			const result = await sendStoredGenericWebhook('jsons://receiver.example.org/secret', body, ids, AbortSignal.timeout(1000));
			expect(result).toEqual({ success: false, status, retryable, retryAfterMs: 37000 });
			expect(JSON.stringify(result)).not.toContain('secret');
		}
	});

	test('network timeouts are retryable; unsafe URLs, malformed auth and redirects are permanent', async () => {
		let calls = 0;
		globalThis.fetch = (async () => { calls++; throw new Error('https://user:secret@host'); }) as any;
		expect(await sendStoredGenericWebhook('jsons://receiver.example.org', body, ids, AbortSignal.timeout(1000))).toEqual({ success: false, retryable: true });
		for (const url of ['json://127.0.0.1/hook', 'json://169.254.169.254/hook', 'jsons://user:%ZZ@host', 'file:///etc/passwd']) expect(await sendStoredGenericWebhook(url, body, ids, AbortSignal.timeout(1000))).toEqual({ success: false, retryable: false });
		expect(calls).toBe(1);
		globalThis.fetch = (async () => new Response('', { status: 302, headers: { Location: 'http://127.0.0.1' } })) as any;
		expect(await sendStoredGenericWebhook('jsons://receiver.example.org', body, ids, AbortSignal.timeout(1000))).toEqual({ success: false, retryable: false });
	});
});
