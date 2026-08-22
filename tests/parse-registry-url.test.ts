/**
 * parseRegistryUrl Unit Tests
 *
 * Tests the registry URL parsing logic used by loginToRegistries() during stack deploys.
 * Covers bare hostnames (ghcr.io), full URLs (https://ghcr.io), ports, and paths.
 *
 * The function is inlined here (mirrors docker.ts) because importing docker.ts triggers
 * the full DB module graph. Same pattern as notifications.test.ts.
 *
 * Run with: bun test tests/unit/parse-registry-url.test.ts
 */

import { describe, test, expect } from 'bun:test';

// Mirrors parseRegistryUrl() from src/lib/server/docker.ts
function parseRegistryUrl(url: string): { host: string; path: string; fullRegistry: string; protocol: string } {
	const protocol = url.startsWith('http://') ? 'http' : 'https';
	const withoutProtocol = url.replace(/^https?:\/\//, '');
	const trimmed = withoutProtocol.replace(/\/$/, '');
	const slashIndex = trimmed.indexOf('/');
	if (slashIndex === -1) {
		return { host: trimmed, path: '', fullRegistry: trimmed, protocol };
	}
	const host = trimmed.substring(0, slashIndex);
	const path = trimmed.substring(slashIndex);
	return { host, path, fullRegistry: trimmed, protocol };
}

describe('parseRegistryUrl', () => {
	test('bare hostname without protocol', () => {
		const result = parseRegistryUrl('ghcr.io');
		expect(result.host).toBe('ghcr.io');
		expect(result.protocol).toBe('https');
		expect(result.path).toBe('');
	});

	test('hostname with https protocol', () => {
		const result = parseRegistryUrl('https://ghcr.io');
		expect(result.host).toBe('ghcr.io');
		expect(result.protocol).toBe('https');
		expect(result.path).toBe('');
	});

	test('hostname with http protocol', () => {
		const result = parseRegistryUrl('http://registry.local:5000');
		expect(result.host).toBe('registry.local:5000');
		expect(result.protocol).toBe('http');
		expect(result.path).toBe('');
	});

	test('hostname with port and no protocol', () => {
		const result = parseRegistryUrl('registry.local:5000');
		expect(result.host).toBe('registry.local:5000');
		expect(result.protocol).toBe('https');
	});

	test('hostname with org path', () => {
		const result = parseRegistryUrl('ghcr.io/myorg');
		expect(result.host).toBe('ghcr.io');
		expect(result.path).toBe('/myorg');
		expect(result.fullRegistry).toBe('ghcr.io/myorg');
	});

	test('full URL with org path', () => {
		const result = parseRegistryUrl('https://ghcr.io/myorg');
		expect(result.host).toBe('ghcr.io');
		expect(result.path).toBe('/myorg');
	});

	test('trailing slash is stripped', () => {
		const result = parseRegistryUrl('ghcr.io/');
		expect(result.host).toBe('ghcr.io');
		expect(result.path).toBe('');
	});

	test('Docker Hub registry', () => {
		const result = parseRegistryUrl('https://index.docker.io/v1/');
		expect(result.host).toBe('index.docker.io');
		expect(result.path).toBe('/v1');
	});

	test('private registry with port and path', () => {
		const result = parseRegistryUrl('http://registry.example.com:5000/team');
		expect(result.host).toBe('registry.example.com:5000');
		expect(result.path).toBe('/team');
		expect(result.protocol).toBe('http');
	});
});

describe('loginToRegistries host extraction (issue #397)', () => {
	// These test the specific scenario from issue #397:
	// loginToRegistries() used `new URL(reg.url)` which throws on bare hostnames.
	// Now it uses parseRegistryUrl() which handles all formats.

	test('bare hostname produces valid docker login host', () => {
		const { host } = parseRegistryUrl('ghcr.io');
		expect(host).toBe('ghcr.io');
	});

	test('https URL produces same host as bare hostname', () => {
		const bare = parseRegistryUrl('ghcr.io');
		const full = parseRegistryUrl('https://ghcr.io');
		expect(bare.host).toBe(full.host);
	});

	test('local registry with port produces host:port', () => {
		const { host } = parseRegistryUrl('registry.local:5000');
		expect(host).toBe('registry.local:5000');
	});

	test('new URL() would throw on bare hostname (the old bug)', () => {
		// This confirms the original bug: new URL('ghcr.io') throws
		expect(() => new URL('ghcr.io')).toThrow();
		// But parseRegistryUrl handles it fine
		expect(() => parseRegistryUrl('ghcr.io')).not.toThrow();
	});
});
