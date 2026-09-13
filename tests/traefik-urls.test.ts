import { describe, test, expect } from 'bun:test';
import { extractTraefikUrls } from '../src/lib/utils/traefik-urls';

describe('extractTraefikUrls', () => {
	test('returns empty for no labels / null / undefined', () => {
		expect(extractTraefikUrls(null)).toEqual([]);
		expect(extractTraefikUrls(undefined)).toEqual([]);
		expect(extractTraefikUrls({})).toEqual([]);
	});

	test('ignores containers with no Traefik labels', () => {
		expect(extractTraefikUrls({ 'com.docker.compose.project': 'foo' })).toEqual([]);
	});

	test('plain Host() defaults to https', () => {
		const out = extractTraefikUrls({
			'traefik.http.routers.app.rule': 'Host(`app.example.com`)'
		});
		expect(out).toEqual([{ url: 'https://app.example.com', router: 'app' }]);
	});

	test('entrypoints=websecure → https', () => {
		const out = extractTraefikUrls({
			'traefik.http.routers.app.rule': 'Host(`app.example.com`)',
			'traefik.http.routers.app.entrypoints': 'websecure'
		});
		expect(out[0].url).toBe('https://app.example.com');
	});

	test('entrypoints=web → http', () => {
		const out = extractTraefikUrls({
			'traefik.http.routers.app.rule': 'Host(`app.example.com`)',
			'traefik.http.routers.app.entrypoints': 'web'
		});
		expect(out[0].url).toBe('http://app.example.com');
	});

	test('explicit tls=true overrides entrypoints', () => {
		const out = extractTraefikUrls({
			'traefik.http.routers.app.rule': 'Host(`app.example.com`)',
			'traefik.http.routers.app.entrypoints': 'web',
			'traefik.http.routers.app.tls': 'true'
		});
		expect(out[0].url).toBe('https://app.example.com');
	});

	test('appends PathPrefix', () => {
		const out = extractTraefikUrls({
			'traefik.http.routers.api.rule': 'Host(`api.example.com`) && PathPrefix(`/v1`)',
			'traefik.http.routers.api.entrypoints': 'websecure'
		});
		expect(out[0].url).toBe('https://api.example.com/v1');
	});

	test('emits one URL per Host() in a multi-host rule', () => {
		const out = extractTraefikUrls({
			'traefik.http.routers.web.rule': 'Host(`a.example.com`) || Host(`b.example.com`)',
			'traefik.http.routers.web.entrypoints': 'websecure'
		});
		expect(out.map((u) => u.url)).toEqual([
			'https://a.example.com',
			'https://b.example.com'
		]);
	});

	test('dedupes identical hosts across routers', () => {
		const out = extractTraefikUrls({
			'traefik.http.routers.a.rule': 'Host(`same.example.com`)',
			'traefik.http.routers.b.rule': 'Host(`same.example.com`)'
		});
		expect(out).toHaveLength(1);
		expect(out[0].url).toBe('https://same.example.com');
	});

	test('skips routers with no Host() (PathPrefix-only / HostRegexp)', () => {
		expect(
			extractTraefikUrls({
				'traefik.http.routers.api.rule': 'PathPrefix(`/api`)',
				'traefik.http.routers.regex.rule': 'HostRegexp(`{subdomain:[a-z]+}.example.com`)'
			})
		).toEqual([]);
	});

	test('accepts double-quoted and single-quoted Host()', () => {
		const out = extractTraefikUrls({
			'traefik.http.routers.dq.rule': 'Host("dq.example.com")',
			'traefik.http.routers.sq.rule': "Host('sq.example.com')"
		});
		expect(out.map((u) => u.url).sort()).toEqual([
			'https://dq.example.com',
			'https://sq.example.com'
		]);
	});

	test('multiple routers on one container each produce a URL', () => {
		const out = extractTraefikUrls({
			'traefik.http.routers.api.rule': 'Host(`api.example.com`)',
			'traefik.http.routers.api.entrypoints': 'websecure',
			'traefik.http.routers.ui.rule': 'Host(`ui.example.com`)',
			'traefik.http.routers.ui.entrypoints': 'web'
		});
		expect(out.map((u) => u.url).sort()).toEqual([
			'http://ui.example.com',
			'https://api.example.com'
		]);
	});
});
