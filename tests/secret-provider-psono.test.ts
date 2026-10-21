// Drives the REAL psonoProvider.resolveBulk against a mocked Psono server (#1784 follow-up:
// the bulk selector can narrow the pull by secret title). undici's `request` is replaced
// with a fake for ONE host only and delegates everything else to the real implementation,
// so this process-global mock does not change what any other suite sees.
import { describe, test, expect, mock } from 'bun:test';
import { xsalsa20poly1305 } from '@noble/ciphers/salsa.js';

const HOST = 'https://psono.example.org';
const API_KEY_SECRET = 'a'.repeat(64);
const ID_HOMELABLE = '00000000-0000-4000-8000-000000000001';
const ID_RACKPAD = '00000000-0000-4000-8000-000000000002';
const ID_NOTE = '00000000-0000-4000-8000-000000000003';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** Seals a payload the way Psono does (see psono-core.test.ts). */
function seal(content: unknown, apiKeySecret: string) {
	const contentKey = new Uint8Array(32).fill(7);
	const dataNonce = new Uint8Array(24).fill(1);
	const keyNonce = new Uint8Array(24).fill(2);
	const data = xsalsa20poly1305(contentKey, dataNonce).encrypt(
		new TextEncoder().encode(JSON.stringify(content))
	);
	const keyText = new TextEncoder().encode(hex(contentKey));
	const secretKey = xsalsa20poly1305(Uint8Array.from(Buffer.from(apiKeySecret, 'hex')), keyNonce).encrypt(keyText);
	return {
		data: hex(data),
		data_nonce: hex(dataNonce),
		secret_key: hex(secretKey),
		secret_key_nonce: hex(keyNonce)
	};
}

// Two Environment Variables secrets whose SECRET_KEY collides, plus a note.
const SECRETS: Record<string, unknown> = {
	[ID_HOMELABLE]: {
		environment_variables_title: 'homelable',
		environment_variables_variables: [
			{ key: 'SECRET_KEY', value: 'homelable-secret' },
			{ key: 'MCP_API_KEY', value: 'homelable-mcp' }
		]
	},
	[ID_RACKPAD]: {
		environment_variables_title: 'rackpad',
		environment_variables_variables: [
			{ key: 'SECRET_KEY', value: 'rackpad-secret' },
			{ key: 'RACKPAD_ONLY', value: 'rackpad-only' }
		]
	},
	[ID_NOTE]: { note_title: 'A note', note_notes: 'not an env var' }
};

const real = await import('undici');
mock.module('undici', () => ({
	...real,
	request: async (url: string, opts: { body?: string }) => {
		if (!String(url).startsWith(HOST)) return (real.request as any)(url, opts);
		const payload = JSON.parse(opts.body ?? '{}');
		const reply = (code: number, body: unknown) => ({
			statusCode: code,
			body: { text: async () => JSON.stringify(body) }
		});
		if (String(url).endsWith('/api-key-access/inspect/')) {
			return reply(200, { api_key_secrets: Object.keys(SECRETS).map((secret_id) => ({ secret_id })) });
		}
		if (String(url).endsWith('/api-key-access/secret/')) {
			const secret = SECRETS[payload.secret_id];
			return secret ? reply(200, seal(secret, API_KEY_SECRET)) : reply(400, 'NO_PERMISSION_OR_NOT_EXIST');
		}
		return reply(404, 'NOT_FOUND');
	}
}));

const { psonoProvider } = await import('../src/lib/server/secretproviders/psono.ts');
const config = { serverUrl: HOST, apiKeyId: 'key-id', apiKeySecretKey: API_KEY_SECRET } as any;

async function bulk(selector?: string) {
	const warnings: string[] = [];
	const orig = console.warn;
	console.warn = (...a: unknown[]) => warnings.push(a.join(' '));
	try {
		return { vars: await psonoProvider.resolveBulk(config, selector as string), warnings };
	} finally {
		console.warn = orig;
	}
}

describe('psonoProvider.resolveBulk: selector narrows the pull by secret title', () => {
	test('a plain enable value pulls every granted secret (first value wins on a collision)', async () => {
		const { vars, warnings } = await bulk('1');
		expect(vars).toEqual({
			SECRET_KEY: 'homelable-secret',
			MCP_API_KEY: 'homelable-mcp',
			RACKPAD_ONLY: 'rackpad-only',
			A_NOTE: 'not an env var' // a plain secret still becomes a variable named after its title
		});
		expect(warnings.some((w) => w.includes('SECRET_KEY appears more than once'))).toBe(true);
	});

	test('REGRESSION: any text without the title: prefix keeps pulling everything', async () => {
		for (const sel of ['', 'true', 'all', 'homelable', 'whatever you had here']) {
			const { vars } = await bulk(sel);
			expect(Object.keys(vars).sort()).toEqual(['A_NOTE', 'MCP_API_KEY', 'RACKPAD_ONLY', 'SECRET_KEY']);
		}
	});

	test('title:<name> keeps only that secret, with no collision', async () => {
		const { vars, warnings } = await bulk('title:homelable');
		expect(vars).toEqual({ SECRET_KEY: 'homelable-secret', MCP_API_KEY: 'homelable-mcp' });
		expect(warnings.some((w) => w.includes('more than once'))).toBe(false);
		expect((await bulk('title:rackpad')).vars).toEqual({
			SECRET_KEY: 'rackpad-secret',
			RACKPAD_ONLY: 'rackpad-only'
		});
	});

	test('several titles, case-insensitive and trimmed', async () => {
		const { vars } = await bulk('Title: Homelable , RACKPAD');
		expect(Object.keys(vars).sort()).toEqual(['MCP_API_KEY', 'RACKPAD_ONLY', 'SECRET_KEY']);
		expect(vars.SECRET_KEY).toBe('homelable-secret');
	});

	test('a title that matches nothing fails the deploy with a clear message', async () => {
		await expect(bulk('title:nope')).rejects.toThrow(/no readable secret titled "nope".*among the 3/);
	});

	test('one missing title among several fails too (no half-resolved stack)', async () => {
		await expect(bulk('title:homelable,missing')).rejects.toThrow(/titled "missing"/);
	});

	test('title: with no names is rejected instead of pulling everything', async () => {
		await expect(bulk('title:')).rejects.toThrow(/names no secret/);
		await expect(bulk('title: , ,')).rejects.toThrow(/names no secret/);
	});
});
