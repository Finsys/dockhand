/**
 * redactEnvironment: strip the tlsKey / hawserToken secrets from an environment before
 * it leaves the server, replacing them with hasTlsKey / hasHawserToken booleans.
 * The private TLS client key authenticates straight to the Docker daemon, so it must
 * never appear in an API response.
 */
import { describe, it, expect } from 'bun:test';
import { redactEnvironment } from '../src/lib/server/environment-redact';

describe('redactEnvironment', () => {
	it('removes tlsKey and hawserToken from the output', () => {
		const out = redactEnvironment({
			id: 1,
			name: 'prod',
			tlsKey: '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----',
			hawserToken: 'super-secret-token',
			tlsCa: 'CA',
			tlsCert: 'CERT'
		} as any);
		expect('tlsKey' in out).toBe(false);
		expect('hawserToken' in out).toBe(false);
		// the JSON serialization a client would see must not contain the secret text
		expect(JSON.stringify(out)).not.toContain('SECRET');
		expect(JSON.stringify(out)).not.toContain('super-secret-token');
	});

	it('sets hasTlsKey / hasHawserToken true when a secret is present', () => {
		const out = redactEnvironment({ id: 1, name: 'p', tlsKey: 'k', hawserToken: 't' } as any);
		expect(out.hasTlsKey).toBe(true);
		expect(out.hasHawserToken).toBe(true);
	});

	it('sets the flags false when the secret is null / empty', () => {
		const out = redactEnvironment({ id: 1, name: 'p', tlsKey: null, hawserToken: '' } as any);
		expect(out.hasTlsKey).toBe(false);
		expect(out.hasHawserToken).toBe(false);
	});

	it('keeps the public tlsCa / tlsCert and all other fields', () => {
		const out = redactEnvironment({
			id: 7,
			name: 'p',
			tlsCa: 'CA-PUBLIC',
			tlsCert: 'CERT-PUBLIC',
			connectionType: 'direct',
			tlsKey: 'k',
			hawserToken: 't'
		} as any) as any;
		expect(out.tlsCa).toBe('CA-PUBLIC');
		expect(out.tlsCert).toBe('CERT-PUBLIC');
		expect(out.connectionType).toBe('direct');
		expect(out.id).toBe(7);
	});
});
