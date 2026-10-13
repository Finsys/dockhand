/**
 * Basic auth for apprise:// and json:// notification URLs (#1611).
 * fetch() rejects URLs with credentials, so user:pass@ must become an Authorization header.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { splitBasicAuth } from '../src/lib/server/notifications/shared';
import { sendApprise } from '../src/lib/server/notifications/apprise';
import { sendGenericWebhook } from '../src/lib/server/notifications/generic-webhook';

const basic = (creds: string) => `Basic ${Buffer.from(creds).toString('base64')}`;

describe('splitBasicAuth', () => {
	test('no userinfo means no header', () => {
		expect(splitBasicAuth('apprise.example.com:8000')).toEqual({ host: 'apprise.example.com:8000', authHeader: null });
	});

	test('user:pass becomes a Basic header', () => {
		expect(splitBasicAuth('user:pass@host:8000')).toEqual({ host: 'host:8000', authHeader: basic('user:pass') });
	});

	test('percent-encoded special characters are decoded', () => {
		expect(splitBasicAuth('us%40er:p%3Aa%2Fs%40s@host')).toEqual({ host: 'host', authHeader: basic('us@er:p:a/s@s') });
	});

	test('encoded ? and % are decoded', () => {
		expect(splitBasicAuth('u:a%3Fb%25c@host')).toEqual({ host: 'host', authHeader: basic('u:a?b%c') });
	});

	test('user without password', () => {
		expect(splitBasicAuth('user@host')).toEqual({ host: 'host', authHeader: basic('user:') });
	});

	test('empty userinfo is dropped without a header', () => {
		expect(splitBasicAuth('@host')).toEqual({ host: 'host', authHeader: null });
	});

	test('non-latin1 credentials still yield an ASCII header', () => {
		const { authHeader } = splitBasicAuth('%C5%BC%C3%B3%C5%82w:has%C5%82o@host');
		expect(authHeader).toBe(basic('żółw:hasło'));
	});

	test('an @ after a backslash is path, not userinfo', () => {
		expect(splitBasicAuth('hooks.example.com\\in@x.example.org')).toEqual({ host: 'hooks.example.com\\in@x.example.org', authHeader: null });
	});

	test('malformed percent-encoding throws without echoing the credentials', () => {
		expect(() => splitBasicAuth('user:%E0%A4%A@host')).toThrow('malformed percent-encoding in URL credentials');
	});
});

describe('senders put credentials in a header, not the URL', () => {
	const realFetch = globalThis.fetch;
	let calls: { url: string; headers: Record<string, string> }[] = [];

	function stubFetch() {
		calls = [];
		globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
			calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
			return new Response('ok', { status: 200 });
		}) as typeof fetch;
	}

	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test('apprises://user:pass@host/prefix/key', async () => {
		stubFetch();
		const result = await sendApprise('apprises://admin:s%40cret@apprise.example.com:8443/apprise/mykey?tag=ops', { title: 't', message: 'm' });
		expect(result).toEqual({ success: true });
		expect(calls[0].url).toBe('https://apprise.example.com:8443/apprise/notify/mykey');
		expect(calls[0].headers['Authorization']).toBe(basic('admin:s@cret'));
		expect(calls[0].headers['Content-Type']).toBe('application/json');
	});

	test('apprise:// without credentials sends no Authorization', async () => {
		stubFetch();
		await sendApprise('apprise://apprise.example.com/mykey', { title: 't', message: 'm' });
		expect(calls[0].url).toBe('http://apprise.example.com/notify/mykey');
		expect(calls[0].headers['Authorization']).toBeUndefined();
	});

	test('jsons://user:pass@host/path?query keeps path and query', async () => {
		stubFetch();
		const result = await sendGenericWebhook('jsons://bot:p%2Fw@hooks.example.com/in/abc?x=1', { title: 't', message: 'm' });
		expect(result).toEqual({ success: true });
		expect(calls[0].url).toBe('https://hooks.example.com/in/abc?x=1');
		expect(calls[0].headers['Authorization']).toBe(basic('bot:p/w'));
	});

	test('json:// without credentials is unchanged', async () => {
		stubFetch();
		await sendGenericWebhook('json://hooks.example.com/in', { title: 't', message: 'm' });
		expect(calls[0].url).toBe('http://hooks.example.com/in');
		expect(calls[0].headers['Authorization']).toBeUndefined();
	});

	test('json://host with no path and an @ in the query is not treated as credentials', async () => {
		stubFetch();
		await sendGenericWebhook('json://hooks.example.com?to=a@b.c', { title: 't', message: 'm' });
		expect(calls[0].url).toBe('http://hooks.example.com?to=a@b.c');
		expect(calls[0].headers['Authorization']).toBeUndefined();
	});

	test('json:// with a backslash before @ still targets the original host', async () => {
		stubFetch();
		await sendGenericWebhook('json://hooks.example.com\\in@x.example.org/p', { title: 't', message: 'm' });
		expect(new URL(calls[0].url).hostname).toBe('hooks.example.com');
		expect(calls[0].headers['Authorization']).toBeUndefined();
	});

	test('malformed credentials fail the send without a request', async () => {
		stubFetch();
		const result = await sendApprise('apprise://u:%ZZ@apprise.example.com/key', { title: 't', message: 'm' });
		expect(result.success).toBe(false);
		expect(result.error).not.toContain('%ZZ');
		expect(calls).toHaveLength(0);
	});
});

describe('an @ inside the password', () => {
	// The split must take the LAST @, as the URL parser does. Taking the first one
	// sends truncated credentials to a host the password's own text chose - so this
	// case is what pins the choice, and every other fixture passes either way.
	test('the host is what follows the final @, and the password keeps its own', () => {
		expect(splitBasicAuth('user:p@ss@host.example.com')).toEqual({
			host: 'host.example.com',
			authHeader: basic('user:p@ss')
		});
	});

	test('several @ in the password still leave the real host', () => {
		expect(splitBasicAuth('u:a@b@c@host.example.com')).toEqual({
			host: 'host.example.com',
			authHeader: basic('u:a@b@c')
		});
	});
});
