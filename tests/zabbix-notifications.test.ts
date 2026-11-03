import { afterEach, describe, expect, test } from 'bun:test';
import type { Dispatcher } from 'undici';
import { sendZabbix } from '../src/lib/server/notifications/zabbix';
import { sendGenericWebhook } from '../src/lib/server/notifications/generic-webhook';

const payload = { title: 'Test', message: 'Hello' };
const url = 'zabbixs://192.168.1.10?token=secret&host=docker&key=events';
const realFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit & { dispatcher?: Dispatcher } }[];

function stubFetch(status = 200) {
	calls = [];
	globalThis.fetch = (async (input: string | URL, init: RequestInit) => {
		calls.push({ url: String(input), init });
		return new Response(JSON.stringify({ result: { response: 'success' } }), { status });
	}) as typeof fetch;
}

afterEach(() => { globalThis.fetch = realFetch; });

describe('Zabbix channel TLS verification', () => {
	test('verifies TLS by default and preserves the API request', async () => {
		stubFetch();
		expect(await sendZabbix(url, payload)).toEqual({ success: true });
		expect(calls[0].init.dispatcher).toBeUndefined();
		expect(calls[0].url).toBe('https://192.168.1.10/api_jsonrpc.php');
		expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer secret' });
		expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ method: 'history.push' });
	});

	test('uses a separate dispatcher only for explicitly opted-in HTTPS sends', async () => {
		stubFetch();
		expect(await sendZabbix(url, payload, true)).toEqual({ success: true });
		expect(calls[0].init.dispatcher).toBeDefined();
		expect(calls[0].init.redirect).toBe('manual');
		expect(calls[0].init.signal).toBeDefined();
		await sendZabbix(url, payload, false);
		expect(calls[1].init.dispatcher).toBeUndefined();
		await sendGenericWebhook('jsons://hooks.example.com/events', payload);
		expect(calls[2].init.dispatcher).toBeUndefined();
	});

	test('does not apply a TLS override to HTTP', async () => {
		stubFetch();
		await sendZabbix(url.replace('zabbixs:', 'zabbix:'), payload, true);
		expect(calls[0].init.dispatcher).toBeUndefined();
	});

	test('still blocks metadata endpoints and redirects when opted in', async () => {
		stubFetch(302);
		expect((await sendZabbix(url.replace('192.168.1.10', '169.254.169.254'), payload, true)).success).toBe(false);
		expect(calls).toHaveLength(0);
		expect((await sendZabbix(url, payload, true)).error).toContain('refusing to follow redirect');
	});

	test('does not treat a non-boolean API value as consent', async () => {
		stubFetch();
		await sendZabbix(url, payload, 'false' as unknown as boolean);
		expect(calls[0].init.dispatcher).toBeUndefined();
	});
});
