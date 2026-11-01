/**
 * Infisical bulk pull talks to GET /api/v4/secrets and flattens imported
 * secrets itself. These cover the URL (projectId, includeImports) and the
 * precedence rules Infisical documents for imports — no network.
 */
import { describe, test, expect } from 'bun:test';
import { collectInfisicalSecrets, infisicalSecretsUrl } from '../src/lib/server/secretproviders/infisical';

describe('infisicalSecretsUrl', () => {
	test('lists secrets on /api/v4/secrets with projectId and includeImports', () => {
		const url = new URL(infisicalSecretsUrl('https://app.infisical.com', 'proj-1', 'prod', '/db'));
		expect(url.origin + url.pathname).toBe('https://app.infisical.com/api/v4/secrets');
		expect(url.searchParams.get('projectId')).toBe('proj-1');
		expect(url.searchParams.get('environment')).toBe('prod');
		expect(url.searchParams.get('secretPath')).toBe('/db');
		expect(url.searchParams.get('viewSecretValue')).toBe('true');
		expect(url.searchParams.get('expandSecretReferences')).toBe('true');
		expect(url.searchParams.get('includeImports')).toBe('true');
		expect(url.searchParams.has('workspaceId')).toBe(false);
	});

	test('omits empty projectId and environment so a service token can infer them', () => {
		const url = new URL(infisicalSecretsUrl('https://eu.infisical.com/', undefined, '', '/'));
		expect(url.searchParams.has('projectId')).toBe(false);
		expect(url.searchParams.has('environment')).toBe(false);
		expect(url.searchParams.get('secretPath')).toBe('/');
		expect(url.searchParams.get('includeImports')).toBe('true');
	});

	test('defaults a blank path to / and strips a trailing slash on the host', () => {
		const url = new URL(infisicalSecretsUrl('https://infisical.example.com/', 'proj', 'dev', ''));
		expect(url.origin + url.pathname).toBe('https://infisical.example.com/api/v4/secrets');
		expect(url.searchParams.get('secretPath')).toBe('/');
	});

	test('rejects a cloud-metadata host before building the request', () => {
		expect(() => infisicalSecretsUrl('http://169.254.169.254', 'proj', 'dev', '/')).toThrow(/host not allowed/);
	});
});

describe('collectInfisicalSecrets', () => {
	test('local secrets override imports, and a later import overrides an earlier one', () => {
		const out = collectInfisicalSecrets({
			imports: [
				{
					secrets: [
						{ secretKey: 'SHARED', secretValue: 'from-first' },
						{ secretKey: 'ONLY_FIRST', secretValue: 'a' }
					]
				},
				{
					secrets: [
						{ secretKey: 'SHARED', secretValue: 'from-second' },
						{ secretKey: 'ONLY_SECOND', secretValue: 'b' }
					]
				}
			],
			secrets: [
				{ secretKey: 'SHARED', secretValue: 'local' },
				{ secretKey: 'ONLY_LOCAL', secretValue: 'c' }
			]
		});
		expect(out).toEqual({
			SHARED: 'local',
			ONLY_FIRST: 'a',
			ONLY_SECOND: 'b',
			ONLY_LOCAL: 'c'
		});
	});

	test('returns only destination secrets when imports are absent', () => {
		expect(collectInfisicalSecrets({ secrets: [{ secretKey: 'A', secretValue: '1' }] })).toEqual({ A: '1' });
	});

	test('returns an empty map for an empty payload', () => {
		expect(collectInfisicalSecrets({})).toEqual({});
	});
});
