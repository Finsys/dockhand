/**
 * The provider edit form pre-fills NON-secret config fields (host, projectId, mount,
 * ...) but the token must never leave the server. redactProviderConfig strips secrets
 * so GET /api/secret-providers/[id] can return the coordinates without the token.
 */
import { describe, test, expect } from 'bun:test';
import {
	redactProviderConfig,
	SECRET_CONFIG_KEYS
} from '../src/lib/server/secretproviders/shared';

describe('SECRET_CONFIG_KEYS', () => {
	test('token is the secret key (matches the password fields in the modal)', () => {
		expect(SECRET_CONFIG_KEYS.has('token')).toBe(true);
	});
	test('non-secret coordinates are NOT marked secret', () => {
		for (const k of ['host', 'address', 'projectId', 'environment', 'path', 'namespace', 'mount', 'project', 'config']) {
			expect(SECRET_CONFIG_KEYS.has(k)).toBe(false);
		}
	});
});

describe('redactProviderConfig', () => {
	test('strips the token, keeps the non-secret coordinates', () => {
		const out = redactProviderConfig({
			address: 'https://vault.example.com',
			token: 'hvs.SECRET',
			mount: 'kv',
			namespace: 'admin'
		} as any);
		expect(out).toEqual({ address: 'https://vault.example.com', mount: 'kv', namespace: 'admin' });
		expect('token' in out).toBe(false);
	});

	test('Infisical: keeps host/projectId/environment/path, drops token', () => {
		const out = redactProviderConfig({
			host: 'https://app.infisical.com',
			token: 'st.SECRET',
			projectId: 'proj-1',
			environment: 'prod',
			path: '/db'
		} as any);
		expect(out).toEqual({ host: 'https://app.infisical.com', projectId: 'proj-1', environment: 'prod', path: '/db' });
	});

	test('service-account (token only) redacts to an empty object', () => {
		expect(redactProviderConfig({ token: 'ops_SECRET' } as any)).toEqual({});
	});

	test('does not mutate the input', () => {
		const input = { address: 'x', token: 'secret' } as any;
		redactProviderConfig(input);
		expect(input.token).toBe('secret');
	});
});
