/**
 * SSRF guard for secret provider hosts (C1).
 *
 * Every REST provider (Vault, Infisical, Doppler, 1Password Connect) makes
 * server-side HTTP requests to a user-supplied host. Without a guard an
 * authenticated user could point a provider at cloud metadata (169.254.169.254)
 * or a loopback service and read the response back through testConnection / bulk
 * pull. assertSafeProviderHost blocks loopback + cloud metadata while allowing
 * ordinary LAN (self-hosted Vault/Infisical/Connect on a private network is a
 * legitimate deployment).
 */
import { describe, test, expect } from 'bun:test';
import { assertSafeProviderHost, sanitizeSelectorPath, parseProviderError } from '../src/lib/server/secretproviders/shared';

describe('assertSafeProviderHost', () => {
	test('blocks cloud-metadata address', () => {
		expect(() => assertSafeProviderHost('http://169.254.169.254', 'Vault')).toThrow();
	});

	test('blocks loopback (localhost + 127.0.0.1)', () => {
		expect(() => assertSafeProviderHost('http://localhost:8200', 'Vault')).toThrow();
		expect(() => assertSafeProviderHost('http://127.0.0.1:9000', 'Doppler')).toThrow();
	});

	test('allows ordinary LAN host (self-hosted Vault/Connect)', () => {
		expect(() => assertSafeProviderHost('http://192.168.1.50:8200', 'Vault')).not.toThrow();
		expect(() => assertSafeProviderHost('http://10.0.0.5:8080', 'Infisical')).not.toThrow();
	});

	test('allows public SaaS host (api.doppler.com)', () => {
		expect(() => assertSafeProviderHost('https://api.doppler.com', 'Doppler')).not.toThrow();
	});

	// IPv4-mapped IPv6 encoding bypass: new URL() normalizes the dotted form to hex
	// (::ffff:169.254.169.254 -> ::ffff:a9fe:a9fe), so a regex on the dotted form is
	// dead. Every mapped form must resolve to the embedded v4 and be blocked.
	test('blocks IPv4-mapped IPv6 forms reaching loopback/metadata', () => {
		for (const host of [
			'http://[::ffff:169.254.169.254]/x', // metadata, dotted (URL -> hex)
			'http://[::ffff:a9fe:a9fe]/x', // metadata, hex
			'http://[::ffff:7f00:1]:8200/x', // loopback, hex
			'http://[::ffff:127.0.0.1]/x', // loopback, dotted
			'http://[0:0:0:0:0:ffff:127.0.0.1]/x', // loopback, expanded
			'http://[::1]/x', // ipv6 loopback
			'http://[::]/x' // unspecified / all-interfaces
		]) {
			expect(() => assertSafeProviderHost(host, 'Vault')).toThrow();
		}
	});

	test('still allows public IPv6 (not an embedded private v4)', () => {
		expect(() => assertSafeProviderHost('http://[2606:4700:4700::1111]/x', 'Vault')).not.toThrow();
	});

	test('error message names the provider label and the reason', () => {
		try {
			assertSafeProviderHost('http://169.254.169.254', 'HashiCorp Vault');
			throw new Error('should have thrown');
		} catch (e) {
			const msg = (e as Error).message;
			expect(msg).toContain('HashiCorp Vault');
			expect(msg.toLowerCase()).toContain('metadata');
		}
	});
});

// The Vault KV path is concatenated raw into the API URL; the selector comes from a
// stack env var an operator controls. sanitizeSelectorPath must reject traversal and
// encode segments so it can't forge a request to another Vault endpoint.
describe('sanitizeSelectorPath (selector path injection)', () => {
	test('rejects .. traversal', () => {
		expect(() => sanitizeSelectorPath('../../sys/mounts', 'Vault')).toThrow();
		expect(() => sanitizeSelectorPath('secret/../..', 'Vault')).toThrow();
	});
	test('strips leading slash and keeps a normal path', () => {
		expect(sanitizeSelectorPath('/secret/prod', 'Vault')).toBe('secret/prod');
	});
	test('percent-encodes query/fragment/space characters', () => {
		expect(sanitizeSelectorPath('secret/foo?x=1', 'Vault')).toBe('secret/foo%3Fx%3D1');
		expect(sanitizeSelectorPath('secret/a b', 'Vault')).toBe('secret/a%20b');
	});
});

// testConnection shows a parsed provider error (good UX) but never reflects an
// arbitrary upstream body: a non-provider host probed via SSRF returns HTML/text that
// doesn't match a provider error shape, so parseProviderError returns null and only
// the status is shown.
describe('parseProviderError (error reflection / SSRF probing)', () => {
	test('extracts a message from known provider error shapes', () => {
		expect(parseProviderError('{"errors":["permission denied"]}')).toBe('permission denied');
		expect(parseProviderError('{"messages":["Invalid Auth token"],"success":false}')).toBe('Invalid Auth token');
		expect(parseProviderError('{"message":"project not found"}')).toBe('project not found');
	});
	test('returns null for anything that is not a provider error shape', () => {
		expect(parseProviderError('<html>502 Bad Gateway</html>')).toBeNull(); // SSRF probe of a LAN service
		expect(parseProviderError('plain text')).toBeNull();
		expect(parseProviderError('{"unrelated":"x"}')).toBeNull();
		expect(parseProviderError('')).toBeNull();
		expect(parseProviderError(null)).toBeNull();
	});
	test('caps message length', () => {
		const long = 'x'.repeat(1000);
		const out = parseProviderError(`{"message":"${long}"}`);
		expect(out!.length).toBeLessThanOrEqual(200);
	});
});

// Guard against a provider silently dropping the wiring: each REST provider's
// base-URL helper must call assertSafeProviderHost. A source-level check catches a
// future refactor that forgets one provider (the exact shape of the C1 bug).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const providerDir = join(here, '..', 'src', 'lib', 'server', 'secretproviders');

describe('every REST provider wires the SSRF guard', () => {
	for (const file of ['vault.ts', 'infisical.ts', 'doppler.ts', 'connect.ts']) {
		test(`${file} calls assertSafeProviderHost`, () => {
			const src = readFileSync(join(providerDir, file), 'utf8');
			expect(src).toContain('assertSafeProviderHost(');
		});
	}
});
