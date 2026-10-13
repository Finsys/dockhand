import { describe, test, expect } from 'bun:test';
import { resolveRegistryScheme, type StoredRegistryScheme } from '../src/lib/server/registry-scheme-core';

const http = (host: string, isHub = false): StoredRegistryScheme => ({ host, protocol: 'http', isHub });
const https = (host: string, isHub = false): StoredRegistryScheme => ({ host, protocol: 'https', isHub });

describe('resolveRegistryScheme', () => {
	test('honours a stored http registry for its host (#1580)', () => {
		const stored = [http('10.10.10.10:3000')];
		expect(resolveRegistryScheme('10.10.10.10:3000', stored, false)).toBe('http');
	});

	test('honours a stored https registry for its host', () => {
		const stored = [https('registry.example.com')];
		expect(resolveRegistryScheme('registry.example.com', stored, false)).toBe('https');
	});

	test('defaults to https when the host is not configured', () => {
		const stored = [http('10.10.10.10:3000')];
		expect(resolveRegistryScheme('other.example.com', stored, false)).toBe('https');
	});

	test('defaults to https with no configured registries', () => {
		expect(resolveRegistryScheme('10.10.10.10:3000', [], false)).toBe('https');
	});

	test('an exact host match wins over hub fallback', () => {
		const stored = [http('10.10.10.10:3000'), https('docker.io', true)];
		expect(resolveRegistryScheme('10.10.10.10:3000', stored, false)).toBe('http');
	});

	test('a Docker Hub request matches any stored Hub entry', () => {
		const stored = [https('docker.io', true)];
		expect(resolveRegistryScheme('registry-1.docker.io', stored, true)).toBe('https');
	});

	test('a non-hub host does not borrow a hub scheme', () => {
		const stored = [http('docker.io', true)];
		// requested is not hub and not the same host -> default https, not the hub's http
		expect(resolveRegistryScheme('registry.example.com', stored, false)).toBe('https');
	});

	test('first matching stored host wins', () => {
		const stored = [http('10.10.10.10:3000'), https('10.10.10.10:3000')];
		expect(resolveRegistryScheme('10.10.10.10:3000', stored, false)).toBe('http');
	});
});
