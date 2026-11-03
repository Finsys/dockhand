// Run with Node (the production runtime): node --import tsx --test integration/webhook-tls.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { networkInterfaces, tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { sendZabbix } from '../src/lib/server/notifications/zabbix';
import { sendGenericWebhook } from '../src/lib/server/notifications/generic-webhook';
import { getTlsSkipVerifyDispatcher } from '../src/lib/server/dns-dispatcher';
import { ipCategory } from '../src/lib/server/url-safety';

test('HTTPS webhook TLS opt-out handles self-signed certificates and hostname mismatches in isolation', async () => {
	// Use a LAN address: notificationFetch deliberately rejects literal loopback targets.
	const address = Object.values(networkInterfaces()).flat().find(i => i?.family === 'IPv4' && ipCategory(i.address) === 'private')?.address;
	assert.ok(address, 'This integration test needs a private IPv4 interface');
	const dir = mkdtempSync(join(tmpdir(), 'dockhand-zabbix-tls-'));
	const original = getGlobalDispatcher();
	let trusted: Agent | undefined;
	let server: ReturnType<typeof createServer> | undefined;
	try {
		execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
			'-subj', '/CN=zabbix.example', '-addext', 'subjectAltName=DNS:zabbix.example',
			'-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
		const cert = readFileSync(join(dir, 'cert.pem'));
		let received = 0;
		server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert }, (req, res) => {
			if (req.url === '/api_jsonrpc.php') assert.equal(req.headers.authorization, 'Bearer test-token');
			req.resume();
			received++;
			res.setHeader('Content-Type', 'application/json');
			res.end(JSON.stringify({ result: { response: 'success' } }));
		});
		server.listen(0, address);
		await once(server, 'listening');
		const port = (server.address() as { port: number }).port;
		const url = `zabbixs://${address}:${port}?token=test-token&host=docker&key=events`;
		const payload = { title: 'TLS integration test', message: 'Test' };

		assert.equal((await sendZabbix(url, payload)).success, false, 'self-signed cert rejected by default');
		assert.equal((await sendZabbix(url, payload, true)).success, true, 'explicit opt-out accepts self-signed cert');
		const webhookUrl = `jsons://${address}:${port}/events`;
		assert.equal((await sendGenericWebhook(webhookUrl, payload)).success, false);
		assert.equal((await sendGenericWebhook(webhookUrl, payload, true)).success, true);

		trusted = new Agent({ connect: { ca: cert } });
		setGlobalDispatcher(trusted);
		await assert.rejects(fetch(`https://${address}:${port}`), (error: Error & { cause?: { code?: string } }) =>
			error.cause?.code === 'ERR_TLS_CERT_ALTNAME_INVALID');
		assert.equal((await sendZabbix(url, payload)).success, false, 'trusted cert with wrong hostname rejected');
		assert.equal((await sendZabbix(url, payload, true)).success, true, 'explicit opt-out accepts hostname mismatch');
		assert.equal((await sendZabbix(url, payload, false)).success, false, 'next channel still verifies TLS');
		assert.equal((await sendGenericWebhook(webhookUrl, payload)).success, false, 'generic webhook rejects hostname mismatch');
		assert.equal((await sendGenericWebhook(webhookUrl, payload, true)).success, true);
		assert.equal((await sendGenericWebhook(webhookUrl, payload, false)).success, false);
		assert.equal(received, 4, 'only opted-in requests reached the API');
		assert.equal(getGlobalDispatcher(), trusted, 'opt-out never changes the global dispatcher');
	} finally {
		setGlobalDispatcher(original);
		await trusted?.destroy();
		await getTlsSkipVerifyDispatcher().destroy();
		server?.closeAllConnections();
		if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
		rmSync(dir, { recursive: true, force: true });
	}
});
