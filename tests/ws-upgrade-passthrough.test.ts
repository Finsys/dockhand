/**
 * A request carrying `Connection: upgrade` is not necessarily a WebSocket handshake.
 *
 * Node routes it to the server's `upgrade` event by that header alone, without looking
 * at the path, so an ordinary GET arrives there whenever a proxy leaves the header on a
 * reused keepalive connection - nginx with an `upstream` block does exactly that. The
 * handshake is identified by `Sec-WebSocket-Key`; anything without it must be served as
 * the plain HTTP request it is, or the browser sees an error for a request the app could
 * have answered.
 *
 * The decision is asserted here against the real server source, since server.js cannot
 * be imported under bun (it pulls in ./build).
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(import.meta.dir, '..', 'server.js'), 'utf8');

describe('a non-handshake upgrade request is served, not dropped', () => {
	test('the upgrade handler checks sec-websocket-key before the path', () => {
		const upgrade = SRC.indexOf("server.on('upgrade'");
		expect(upgrade).toBeGreaterThan(-1);
		const body = SRC.slice(upgrade, SRC.indexOf("wss.on('connection'", upgrade));

		const keyCheck = body.indexOf("!req.headers['sec-websocket-key']");
		const pathReject = body.indexOf('if (!isTerminal && !isHawser)');
		expect(keyCheck).toBeGreaterThan(-1);
		expect(pathReject).toBeGreaterThan(-1);
		// Order matters: the path rejection destroys the socket, so a plain GET has to
		// be recognised first or it never reaches the app.
		expect(keyCheck).toBeLessThan(pathReject);
	});

	test('it hands the request to the app rather than answering itself', () => {
		const keyCheck = SRC.indexOf("!req.headers['sec-websocket-key']");
		// Bounded to the branch, so a correct change further down cannot fail this.
		const branch = SRC.slice(keyCheck, SRC.indexOf('if (!isTerminal', keyCheck));
		expect(branch).toContain('new ServerResponse(req)');
		expect(branch).toContain('assignSocket');
		expect(branch).toContain('handler(req, res)');
	});

	test('it only takes over a request with no body', () => {
		// Node stops reading the stream once this event fires, so a body would be partly
		// in `head` and partly still on the socket. Serving it would hand the app an
		// empty or truncated body with no error, and an endpoint reading an absent field
		// as "clear it" would delete data and answer 200.
		const keyCheck = SRC.indexOf("!req.headers['sec-websocket-key']");
		const cond = SRC.slice(keyCheck, SRC.indexOf('{', SRC.indexOf(')', keyCheck)));
		expect(cond).toContain("!req.headers['content-length']");
		expect(cond).toContain("!req.headers['transfer-encoding']");
		// The body is never touched, so there is nothing to put back or truncate.
		const branch = SRC.slice(keyCheck, SRC.indexOf('if (!isTerminal', keyCheck));
		expect(branch).not.toContain('unshift');
	});

	test('the response says the socket is closing, and carries HSTS when HTTPS is on', () => {
		const keyCheck = SRC.indexOf("!req.headers['sec-websocket-key']");
		const branch = SRC.slice(keyCheck, SRC.indexOf('if (!isTerminal', keyCheck));
		// The request asked to upgrade, so Node would default to keep-alive on a socket
		// this branch always ends.
		expect(branch).toContain("res.setHeader('Connection', 'close')");
		// The HTTPS listener sets this per response and this path bypasses it.
		expect(branch).toContain("res.setHeader('Strict-Transport-Security', hstsHeader)");
		// Both before the handler, or the headers are already on the wire.
		expect(branch.indexOf("setHeader('Connection'")).toBeLessThan(branch.indexOf('handler(req, res)'));
		// Module scope, or it is a ReferenceError outside the HTTPS block.
		expect(SRC).toContain('let hstsHeader = null;');
	});

	test('ServerResponse is imported from node:http', () => {
		const imports = SRC.slice(0, SRC.indexOf('const PORT'));
		expect(imports).toMatch(/ServerResponse[^;]*from 'node:http'/);
	});

	test('a real handshake still reaches the websocket paths', () => {
		const upgrade = SRC.indexOf("server.on('upgrade'");
		// Bounded by the handler's own end, not a character count that drifts as the
		// comments around it change.
		const body = SRC.slice(upgrade, SRC.indexOf("wss.on('connection'", upgrade));
		// The two paths that take a handshake, and the ws library adopting the socket.
		expect(body).toContain("url.pathname === '/api/hawser/connect'");
		expect(body).toContain('/exec');
		expect(body).toContain('wss.handleUpgrade');
	});
});
