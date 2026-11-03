import { afterEach, describe, expect, test } from 'bun:test';
import type { Dispatcher } from 'undici';
import { sendDiscord } from '../src/lib/server/notifications/discord';
import { sendSlack } from '../src/lib/server/notifications/slack';
import { sendMattermost } from '../src/lib/server/notifications/mattermost';
import { sendTelegram } from '../src/lib/server/notifications/telegram';
import { sendGotify } from '../src/lib/server/notifications/gotify';
import { sendNtfy } from '../src/lib/server/notifications/ntfy';
import { sendBark } from '../src/lib/server/notifications/bark';
import { sendSignal } from '../src/lib/server/notifications/signal';
import { sendApprise } from '../src/lib/server/notifications/apprise';
import { sendPushover } from '../src/lib/server/notifications/pushover';
import { sendGenericWebhook } from '../src/lib/server/notifications/generic-webhook';
import { sendWorkflows } from '../src/lib/server/notifications/workflows';
import { sendZabbix } from '../src/lib/server/notifications/zabbix';

const payload = { title: 'Test', message: 'Hello' };
const realFetch = globalThis.fetch;
const providers = [
	[sendDiscord, 'discord://id/token'],
	[sendSlack, 'slack://a/b/c'],
	[sendMattermost, 'mmosts://hooks.example.com/token'],
	[sendTelegram, 'tgram://token/chat'],
	[sendGotify, 'gotifys://hooks.example.com/token'],
	[sendNtfy, 'ntfys://hooks.example.com/topic'],
	[sendBark, 'barks://hooks.example.com/key'],
	[sendSignal, 'signals://hooks.example.com/+123/+456'],
	[sendApprise, 'apprises://hooks.example.com/key'],
	[sendPushover, 'pushover://user/token'],
	[sendGenericWebhook, 'jsons://hooks.example.com/events'],
	[sendWorkflows, 'workflows://hooks.example.com/workflow/signature'],
	[sendZabbix, 'zabbixs://hooks.example.com?token=secret&host=docker&key=events']
] as const;

afterEach(() => { globalThis.fetch = realFetch; });

describe('HTTPS webhook TLS verification', () => {
	for (const [send, url] of providers) {
		test(`${send.name} opts out only for this send`, async () => {
			const requests: (RequestInit & { dispatcher?: Dispatcher })[] = [];
			globalThis.fetch = (async (_input: unknown, init: RequestInit) => {
				requests.push(init);
				return new Response(JSON.stringify({ result: { response: 'success' }, code: 200 }));
			}) as typeof fetch;
			await send(url, payload);
			await send(url, payload, true);
			await send(url, payload, false);
			expect(requests).toHaveLength(3);
			expect(requests[0].dispatcher).toBeUndefined();
			expect(requests[1].dispatcher).toBeDefined();
			expect(requests[1].redirect).toBe('manual');
			expect(requests[1].signal).toBeDefined();
			expect(requests[2].dispatcher).toBeUndefined();
		});
	}

	test('HTTP webhooks do not receive a TLS override', async () => {
		let init: (RequestInit & { dispatcher?: Dispatcher }) | undefined;
		globalThis.fetch = (async (_input: unknown, options: RequestInit) => {
			init = options;
			return new Response('{}');
		}) as typeof fetch;
		await sendGenericWebhook('json://hooks.example.com/events', payload, true);
		expect(init).toBeDefined();
		expect(init?.dispatcher).toBeUndefined();
	});
});
