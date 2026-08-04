/**
 * Unit tests for the 1Password Connect secret provider.
 *
 * The Connect backend is a self-hosted REST server we have no Business account
 * for, so these tests mock undici's `request` and exercise the provider's HTTP
 * choreography directly: health check, op:// reference resolution (including the
 * optional section segment and the per-call vault/item cache), the not-found
 * skip+warn path, auth-failure propagation, and the unsupported bulk pull.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * A queued response for the mocked undici `request`. `json`/`text` drive the
 * body helpers the provider calls; `status` is the HTTP status code.
 */
interface MockResponse {
	status: number;
	json?: unknown;
	text?: string;
}

/** Records one outgoing request so tests can assert URL/headers/count. */
interface RecordedCall {
	url: string;
	method?: string;
	headers?: Record<string, string>;
}

let responses: MockResponse[];
let calls: RecordedCall[];

const requestMock = mock(async (url: unknown, opts?: { method?: string; headers?: Record<string, string> }) => {
	calls.push({ url: String(url), method: opts?.method, headers: opts?.headers });
	const next = responses.shift();
	if (!next) {
		throw new Error(`Unexpected request to ${String(url)}: no mock response queued`);
	}
	return {
		statusCode: next.status,
		body: {
			async json() {
				return next.json;
			},
			async text() {
				return next.text ?? (next.json !== undefined ? JSON.stringify(next.json) : '');
			}
		}
	};
});

mock.module('undici', () => ({ request: requestMock }));

// Imported after the mock is registered so connect.ts binds the mocked request.
const { connectProvider } = await import('../src/lib/server/secretproviders/connect');
const { UnsupportedOperationError } = await import('../src/lib/server/secretproviders/shared');

const CONFIG = { host: 'https://connect.example.com/', token: 'test-token' };

/** Queue the responses a single-field resolution walks through. */
function queueSuccessfulResolution() {
	responses = [
		{ status: 200, json: [{ id: 'vault-1', name: 'Prod' }] },
		{ status: 200, json: [{ id: 'item-1', title: 'Database' }] },
		{
			status: 200,
			json: {
				id: 'item-1',
				title: 'Database',
				fields: [{ id: 'f1', label: 'password', value: 's3cret' }]
			}
		}
	];
}

beforeEach(() => {
	responses = [];
	calls = [];
	requestMock.mockClear();
});

afterEach(() => {
	// Fail loudly if a test queued responses it never consumed.
	expect(responses.length).toBe(0);
});

describe('connectProvider capabilities', () => {
	test('advertises the expected type, label, and capability flags', () => {
		expect(connectProvider.type).toBe('op-connect');
		expect(connectProvider.label).toBe('1Password Connect');
		expect(connectProvider.supportsReferences).toBe(true);
		expect(connectProvider.supportsBulk).toBe(false);
	});

	test('isReference matches op:// strings only', () => {
		expect(connectProvider.isReference('op://Prod/Database/password')).toBe(true);
		expect(connectProvider.isReference('  op://Prod/Database/password')).toBe(true);
		expect(connectProvider.isReference('plain-value')).toBe(false);
		expect(connectProvider.isReference(42)).toBe(false);
		expect(connectProvider.isReference(undefined)).toBe(false);
	});
});

describe('testConnection', () => {
	test('rejects empty host or token without hitting the network', async () => {
		expect(await connectProvider.testConnection({ host: '', token: 't' })).toEqual({
			ok: false,
			error: 'Host is empty'
		});
		expect(await connectProvider.testConnection({ host: 'https://x', token: '  ' })).toEqual({
			ok: false,
			error: 'Token is empty'
		});
		expect(requestMock).not.toHaveBeenCalled();
	});

	test('ok on a 2xx /v1/vaults response and sends bearer auth', async () => {
		responses = [{ status: 200, json: [{ id: 'v1', name: 'Vault' }] }];
		const result = await connectProvider.testConnection(CONFIG);
		expect(result).toEqual({ ok: true });
		expect(calls[0].url).toBe('https://connect.example.com/v1/vaults');
		expect(calls[0].headers?.Authorization).toBe('Bearer test-token');
		expect(calls[0].headers?.Accept).toBe('application/json');
	});

	test('ok:false with a clear message on auth failure, without throwing', async () => {
		responses = [{ status: 401, text: 'invalid token' }];
		const result = await connectProvider.testConnection(CONFIG);
		expect(result.ok).toBe(false);
		expect(result.error).toBe('Invalid 1Password Connect token');
	});

	test('ok:false when the request throws (transport error)', async () => {
		responses = [];
		requestMock.mockImplementationOnce(async () => {
			throw new Error('ECONNREFUSED');
		});
		const result = await connectProvider.testConnection(CONFIG);
		expect(result.ok).toBe(false);
		expect(result.error).toContain('ECONNREFUSED');
	});
});

describe('resolveSecretReferences', () => {
	test('returns an empty map for no refs without any request', async () => {
		const result = await connectProvider.resolveSecretReferences(CONFIG, []);
		expect(result.size).toBe(0);
		expect(requestMock).not.toHaveBeenCalled();
	});

	test('resolves a op://vault/item/field reference', async () => {
		queueSuccessfulResolution();
		const ref = 'op://Prod/Database/password';
		const result = await connectProvider.resolveSecretReferences(CONFIG, [ref]);
		expect(result.get(ref)).toBe('s3cret');
		expect(result.size).toBe(1);
		// vaults, items, item detail — three GETs against the v1 base.
		expect(calls.map((c) => c.url)).toEqual([
			'https://connect.example.com/v1/vaults',
			'https://connect.example.com/v1/vaults/vault-1/items',
			'https://connect.example.com/v1/vaults/vault-1/items/item-1'
		]);
	});

	test('resolves a reference with a section segment', async () => {
		responses = [
			{ status: 200, json: [{ id: 'vault-1', name: 'Prod' }] },
			{ status: 200, json: [{ id: 'item-1', title: 'Database' }] },
			{
				status: 200,
				json: {
					id: 'item-1',
					title: 'Database',
					fields: [
						{ id: 'f1', label: 'password', value: 'wrong', section: { id: 's-other' } },
						{
							id: 'f2',
							label: 'password',
							value: 'right',
							section: { id: 's-1', label: 'replica' }
						}
					]
				}
			}
		];
		const ref = 'op://Prod/Database/replica/password';
		const result = await connectProvider.resolveSecretReferences(CONFIG, [ref]);
		expect(result.get(ref)).toBe('right');
	});

	test('matches vault by id and item by id', async () => {
		responses = [
			{ status: 200, json: [{ id: 'vault-1', name: 'Prod' }] },
			{ status: 200, json: [{ id: 'item-1', title: 'Database' }] },
			{
				status: 200,
				json: { id: 'item-1', title: 'Database', fields: [{ id: 'notes', value: 'byid' }] }
			}
		];
		const ref = 'op://vault-1/item-1/notes';
		const result = await connectProvider.resolveSecretReferences(CONFIG, [ref]);
		expect(result.get(ref)).toBe('byid');
	});

	test('caches vault and item lists across refs in one call', async () => {
		responses = [
			{ status: 200, json: [{ id: 'vault-1', name: 'Prod' }] },
			{ status: 200, json: [{ id: 'item-1', title: 'Database' }] },
			{
				status: 200,
				json: { id: 'item-1', title: 'Database', fields: [{ label: 'password', value: 'p1' }] }
			},
			// Second ref hits the same vault+item: only the item-detail GET repeats.
			{
				status: 200,
				json: { id: 'item-1', title: 'Database', fields: [{ label: 'username', value: 'u1' }] }
			}
		];
		const refs = ['op://Prod/Database/password', 'op://Prod/Database/username'];
		const result = await connectProvider.resolveSecretReferences(CONFIG, refs);
		expect(result.get(refs[0])).toBe('p1');
		expect(result.get(refs[1])).toBe('u1');
		// 1 vaults + 1 items + 2 item-details = 4 requests (lists were cached).
		expect(calls.length).toBe(4);
		expect(calls.filter((c) => c.url.endsWith('/v1/vaults')).length).toBe(1);
		expect(calls.filter((c) => c.url.endsWith('/items')).length).toBe(1);
	});

	test('skips and warns a ref whose field is missing, keeping the others', async () => {
		const warn = mock(() => {});
		const original = console.warn;
		console.warn = warn;
		try {
			responses = [
				{ status: 200, json: [{ id: 'vault-1', name: 'Prod' }] },
				{ status: 200, json: [{ id: 'item-1', title: 'Database' }] },
				// missing field -> skip
				{
					status: 200,
					json: { id: 'item-1', title: 'Database', fields: [{ label: 'password', value: 'p1' }] }
				},
				// second ref resolves fine
				{
					status: 200,
					json: { id: 'item-1', title: 'Database', fields: [{ label: 'password', value: 'p1' }] }
				}
			];
			const missing = 'op://Prod/Database/nope';
			const present = 'op://Prod/Database/password';
			const result = await connectProvider.resolveSecretReferences(CONFIG, [missing, present]);
			expect(result.has(missing)).toBe(false);
			expect(result.get(present)).toBe('p1');
			expect(warn).toHaveBeenCalled();
		} finally {
			console.warn = original;
		}
	});

	test('skips a ref whose vault 404s on the specific lookup', async () => {
		const warn = mock(() => {});
		const original = console.warn;
		console.warn = warn;
		try {
			// Empty vault list -> vault not found -> skip+warn, no throw.
			responses = [{ status: 200, json: [] }];
			const ref = 'op://Ghost/Database/password';
			const result = await connectProvider.resolveSecretReferences(CONFIG, [ref]);
			expect(result.size).toBe(0);
			expect(warn).toHaveBeenCalled();
		} finally {
			console.warn = original;
		}
	});

	test('skips a malformed op:// reference', async () => {
		const warn = mock(() => {});
		const original = console.warn;
		console.warn = warn;
		try {
			responses = [];
			const bad = 'op://Prod/Database'; // too few segments
			const result = await connectProvider.resolveSecretReferences(CONFIG, [bad]);
			expect(result.size).toBe(0);
			expect(requestMock).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalled();
		} finally {
			console.warn = original;
		}
	});

	test('throws on an auth failure (401) instead of skipping', async () => {
		responses = [{ status: 401, text: 'unauthorized' }];
		await expect(
			connectProvider.resolveSecretReferences(CONFIG, ['op://Prod/Database/password'])
		).rejects.toThrow(/401/);
	});

	test('throws on a server error (500)', async () => {
		responses = [{ status: 500, text: 'boom' }];
		await expect(
			connectProvider.resolveSecretReferences(CONFIG, ['op://Prod/Database/password'])
		).rejects.toThrow(/500/);
	});
});

describe('resolveBulk', () => {
	test('throws UnsupportedOperationError', async () => {
		await expect(connectProvider.resolveBulk(CONFIG, 'any-selector')).rejects.toBeInstanceOf(
			UnsupportedOperationError
		);
	});

	test('the error message points at using a service account', async () => {
		await expect(connectProvider.resolveBulk(CONFIG, 'any-selector')).rejects.toThrow(
			/service account/
		);
	});
});
