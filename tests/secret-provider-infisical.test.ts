/**
 * Unit tests for the Infisical secret provider.
 *
 * Infisical is open-source and self-hostable, so it is integration-testable
 * against a real instance later. Here we exercise the provider in isolation by
 * mocking undici's `request`, covering:
 *   - a successful bulk pull mapping { secretKey, secretValue } → Record
 *   - the selector / config.path / '/' precedence for the queried path
 *   - an auth failure (HTTP 401) surfacing as a thrown error
 *   - testConnection returning ok on 2xx and a helpful error otherwise
 *   - resolveSecretReferences throwing UnsupportedOperationError (bulk-only)
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';

/**
 * A single mock for undici's `request`. Registered before the provider is
 * imported so the provider's `import { request } from 'undici'` binds to it.
 * Each test sets its behaviour via `requestMock.mockImplementation(...)`.
 */
const requestMock = mock();
mock.module('undici', () => ({ request: requestMock }));

const { infisicalProvider } = await import('../src/lib/server/secretproviders/infisical.ts');
const { UnsupportedOperationError } = await import('../src/lib/server/secretproviders/shared.ts');

/** Builds an undici-style response with json()/text() bodies. */
function response(statusCode: number, json: unknown, text = '') {
	return {
		statusCode,
		body: {
			json: async () => json,
			text: async () => text
		}
	};
}

const baseConfig = {
	host: 'https://app.infisical.com',
	token: 'st.token.value',
	projectId: 'proj-123',
	environment: 'prod',
	path: '/'
};

beforeEach(() => {
	requestMock.mockReset();
});

describe('infisicalProvider capabilities', () => {
	it('advertises bulk-only, no references', () => {
		expect(infisicalProvider.type).toBe('infisical');
		expect(infisicalProvider.label).toBe('Infisical');
		expect(infisicalProvider.supportsBulk).toBe(true);
		expect(infisicalProvider.supportsReferences).toBe(false);
	});

	it('isReference is always false', () => {
		expect(infisicalProvider.isReference('op://vault/item/field')).toBe(false);
		expect(infisicalProvider.isReference('anything')).toBe(false);
		expect(infisicalProvider.isReference(42)).toBe(false);
	});
});

describe('infisicalProvider.resolveBulk', () => {
	it('maps secretKey/secretValue pairs into a flat record', async () => {
		requestMock.mockImplementation(async () =>
			response(200, {
				secrets: [
					{ secretKey: 'DB_PASSWORD', secretValue: 's3cr3t' },
					{ secretKey: 'API_KEY', secretValue: 'abc123' }
				]
			})
		);

		const result = await infisicalProvider.resolveBulk(baseConfig, '');

		expect(result).toEqual({ DB_PASSWORD: 's3cr3t', API_KEY: 'abc123' });

		// Verify the request shape: raw secrets endpoint, bearer auth, and the
		// workspace/environment/path query.
		const [url, opts] = requestMock.mock.calls[0];
		expect(url).toContain('https://app.infisical.com/api/v3/secrets/raw');
		expect(url).toContain('workspaceId=proj-123');
		expect(url).toContain('environment=prod');
		expect(url).toContain('secretPath=%2F');
		expect(opts.method).toBe('GET');
		expect(opts.headers.authorization).toBe('Bearer st.token.value');
	});

	it('tolerates an absent secrets array', async () => {
		requestMock.mockImplementation(async () => response(200, {}));
		const result = await infisicalProvider.resolveBulk(baseConfig, '');
		expect(result).toEqual({});
	});

	it('prefers the selector over config.path for secretPath', async () => {
		requestMock.mockImplementation(async () => response(200, { secrets: [] }));
		await infisicalProvider.resolveBulk({ ...baseConfig, path: '/config' }, '/services/web');
		const [url] = requestMock.mock.calls[0];
		expect(url).toContain('secretPath=%2Fservices%2Fweb');
	});

	it('falls back to config.path when the selector is empty', async () => {
		requestMock.mockImplementation(async () => response(200, { secrets: [] }));
		await infisicalProvider.resolveBulk({ ...baseConfig, path: '/config' }, '');
		const [url] = requestMock.mock.calls[0];
		expect(url).toContain('secretPath=%2Fconfig');
	});

	it('throws on an auth failure (HTTP 401)', async () => {
		requestMock.mockImplementation(async () =>
			response(401, {}, 'Unauthorized: invalid token')
		);
		await expect(infisicalProvider.resolveBulk(baseConfig, '')).rejects.toThrow(/401/);
	});

	it('throws a clear error when the environment is missing', async () => {
		await expect(
			infisicalProvider.resolveBulk({ ...baseConfig, environment: undefined }, '')
		).rejects.toThrow(/Environment is required/);
		// No HTTP call should have been attempted.
		expect(requestMock).not.toHaveBeenCalled();
	});
});

describe('infisicalProvider.resolveSecretReferences', () => {
	it('throws UnsupportedOperationError (bulk-only backend)', async () => {
		await expect(
			infisicalProvider.resolveSecretReferences(baseConfig, ['ref'])
		).rejects.toBeInstanceOf(UnsupportedOperationError);
		await expect(
			infisicalProvider.resolveSecretReferences(baseConfig, ['ref'])
		).rejects.toThrow(/does not support inline references/);
		expect(requestMock).not.toHaveBeenCalled();
	});
});

describe('infisicalProvider.testConnection', () => {
	it('returns ok on a 2xx response', async () => {
		requestMock.mockImplementation(async () => response(200, { secrets: [] }));
		const result = await infisicalProvider.testConnection(baseConfig);
		expect(result.ok).toBe(true);
		const [url] = requestMock.mock.calls[0];
		expect(url).toContain('secretPath=%2F');
	});

	it('returns ok:false with the status on an auth failure', async () => {
		requestMock.mockImplementation(async () => response(401, {}, 'Unauthorized'));
		const result = await infisicalProvider.testConnection(baseConfig);
		expect(result.ok).toBe(false);
		expect(result.error).toContain('401');
	});

	it('does not throw when the transport fails, returns the message', async () => {
		requestMock.mockImplementation(async () => {
			throw new Error('ECONNREFUSED');
		});
		const result = await infisicalProvider.testConnection(baseConfig);
		expect(result.ok).toBe(false);
		expect(result.error).toContain('ECONNREFUSED');
	});

	it('returns a helpful error when projectId is empty (no HTTP call)', async () => {
		const result = await infisicalProvider.testConnection({ ...baseConfig, projectId: '' });
		expect(result.ok).toBe(false);
		expect(result.error).toContain('Project ID');
		expect(requestMock).not.toHaveBeenCalled();
	});

	it('returns a helpful error when environment is empty (no HTTP call)', async () => {
		const result = await infisicalProvider.testConnection({
			...baseConfig,
			environment: undefined
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain('Environment');
		expect(requestMock).not.toHaveBeenCalled();
	});
});
