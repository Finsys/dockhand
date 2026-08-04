/**
 * Unit tests for the HashiCorp Vault (KV v2) secret provider.
 *
 * undici's `request` is mocked so these run without a real Vault server. They
 * cover: a successful KV v2 read (mapping `data.data`, coercing non-strings),
 * the `X-Vault-Namespace` header being sent only when configured, the mount /
 * URL shape, auth failure (403) on both bulk read and testConnection, a missing
 * path (404) surfacing as an error, and the unsupported inline-reference mode.
 *
 * Vault OSS is separately integration-testable against `vault server -dev`.
 */

// `svelte-check` runs over `tests/**` (per .svelte-kit/tsconfig.json) but this
// repo ships no bun type declarations (`@types/bun`), so it cannot resolve the
// `bun:test` built-in. Harmless at runtime — bun provides the module. Drop this
// suppression once `@types/bun` is a dev dependency (see coordinator note).
// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { test, expect, describe, mock, beforeEach } from 'bun:test';

/** Per-test undici stub; each test overrides this before exercising the provider. */
let requestImpl: (url: string, opts: { method: string; headers: Record<string, string> }) => unknown;

mock.module('undici', () => ({
	request: (url: string, opts: { method: string; headers: Record<string, string> }) =>
		requestImpl(url, opts)
}));

const { vaultProvider } = await import('../src/lib/server/secretproviders/vault.ts');
const { UnsupportedOperationError } = await import('../src/lib/server/secretproviders/shared.ts');

/** Fake undici response with a body exposing json()/text()/dump(). */
function makeResponse(
	statusCode: number,
	opts: { json?: unknown; text?: string } = {}
): { statusCode: number; headers: Record<string, string>; body: unknown } {
	return {
		statusCode,
		headers: {},
		body: {
			async json() {
				if ('json' in opts) return opts.json;
				return JSON.parse(opts.text ?? 'null');
			},
			async text() {
				if (opts.text !== undefined) return opts.text;
				return opts.json !== undefined ? JSON.stringify(opts.json) : '';
			},
			async dump() {
				/* drain — no-op in the mock */
			}
		}
	};
}

const baseConfig = { address: 'https://vault.example.com', token: 's.rootToken' };

beforeEach(() => {
	requestImpl = () => {
		throw new Error('unexpected undici.request call');
	};
});

describe('vaultProvider capabilities', () => {
	test('advertises bulk-only, no references', () => {
		expect(vaultProvider.type).toBe('vault');
		expect(vaultProvider.label).toBe('HashiCorp Vault');
		expect(vaultProvider.supportsBulk).toBe(true);
		expect(vaultProvider.supportsReferences).toBe(false);
	});

	test('isReference returns false for anything', () => {
		expect(vaultProvider.isReference('vault://secret/foo#bar')).toBe(false);
		expect(vaultProvider.isReference('op://a/b/c')).toBe(false);
		expect(vaultProvider.isReference(null)).toBe(false);
	});
});

describe('resolveBulk', () => {
	test('reads KV v2 data.data and coerces non-string values', async () => {
		let capturedUrl = '';
		let capturedHeaders: Record<string, string> = {};
		requestImpl = (url, opts) => {
			capturedUrl = url;
			capturedHeaders = opts.headers;
			return makeResponse(200, {
				json: {
					data: {
						data: { DB_PASSWORD: 'hunter2', PORT: 5432, ENABLED: true },
						metadata: { version: 3 }
					}
				}
			});
		};

		const out = await vaultProvider.resolveBulk(baseConfig, 'myapp/config');

		expect(out).toEqual({ DB_PASSWORD: 'hunter2', PORT: '5432', ENABLED: 'true' });
		// mount defaults to 'secret'; address keeps no trailing slash.
		expect(capturedUrl).toBe('https://vault.example.com/v1/secret/data/myapp/config');
		expect(capturedHeaders['X-Vault-Token']).toBe('s.rootToken');
		expect(capturedHeaders['X-Vault-Namespace']).toBeUndefined();
	});

	test('honours a custom mount and strips trailing slash / leading path slash', async () => {
		let capturedUrl = '';
		requestImpl = (url) => {
			capturedUrl = url;
			return makeResponse(200, { json: { data: { data: { K: 'v' } } } });
		};

		await vaultProvider.resolveBulk(
			{ address: 'https://vault.example.com/', token: 't', mount: 'kv' },
			'/team/app'
		);

		expect(capturedUrl).toBe('https://vault.example.com/v1/kv/data/team/app');
	});

	test('sends X-Vault-Namespace when configured', async () => {
		let capturedHeaders: Record<string, string> = {};
		requestImpl = (_url, opts) => {
			capturedHeaders = opts.headers;
			return makeResponse(200, { json: { data: { data: { K: 'v' } } } });
		};

		await vaultProvider.resolveBulk({ ...baseConfig, namespace: 'admin/team' }, 'app');

		expect(capturedHeaders['X-Vault-Namespace']).toBe('admin/team');
		expect(capturedHeaders['X-Vault-Token']).toBe('s.rootToken');
	});

	test('returns empty map when data.data is absent', async () => {
		requestImpl = () => makeResponse(200, { json: { data: { metadata: {} } } });
		const out = await vaultProvider.resolveBulk(baseConfig, 'empty');
		expect(out).toEqual({});
	});

	test('throws a clear "path not found" on 404', async () => {
		requestImpl = () => makeResponse(404, { json: { errors: [] } });
		await expect(vaultProvider.resolveBulk(baseConfig, 'missing/path')).rejects.toThrow(
			/path not found: secret\/missing\/path/
		);
	});

	test('throws on auth failure (403), including Vault error detail', async () => {
		requestImpl = () => makeResponse(403, { json: { errors: ['permission denied'] } });
		await expect(vaultProvider.resolveBulk(baseConfig, 'app')).rejects.toThrow(
			/status 403.*permission denied/
		);
	});
});

describe('testConnection', () => {
	test('ok:true on 2xx from lookup-self', async () => {
		let capturedUrl = '';
		requestImpl = (url) => {
			capturedUrl = url;
			return makeResponse(200, { json: { data: { display_name: 'token' } } });
		};

		const res = await vaultProvider.testConnection(baseConfig);

		expect(res.ok).toBe(true);
		expect(capturedUrl).toBe('https://vault.example.com/v1/auth/token/lookup-self');
	});

	test('ok:false (no throw) on auth failure (403)', async () => {
		requestImpl = () => makeResponse(403, { json: { errors: ['permission denied'] } });
		const res = await vaultProvider.testConnection(baseConfig);
		expect(res.ok).toBe(false);
		expect(res.error).toContain('403');
		expect(res.error).toContain('permission denied');
	});

	test('ok:false on transport error without throwing', async () => {
		requestImpl = () => {
			throw new Error('ECONNREFUSED');
		};
		const res = await vaultProvider.testConnection(baseConfig);
		expect(res.ok).toBe(false);
		expect(res.error).toContain('ECONNREFUSED');
	});

	test('rejects empty address / token before any request', async () => {
		expect((await vaultProvider.testConnection({ address: '', token: 't' })).ok).toBe(false);
		expect((await vaultProvider.testConnection({ address: 'x', token: '' })).ok).toBe(false);
	});
});

describe('resolveSecretReferences', () => {
	test('throws UnsupportedOperationError (bulk-only backend)', async () => {
		await expect(vaultProvider.resolveSecretReferences(baseConfig, ['anything'])).rejects.toThrow(
			UnsupportedOperationError
		);
		await expect(vaultProvider.resolveSecretReferences(baseConfig, [])).rejects.toThrow(
			/does not support inline references/
		);
	});
});
