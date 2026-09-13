import { describe, test, expect } from 'bun:test';
import { extractCaddyUrls } from '../src/lib/utils/caddy-urls';

describe('extractCaddyUrls', () => {
	test('returns empty for no labels / null / undefined / empty', () => {
		expect(extractCaddyUrls(null)).toEqual([]);
		expect(extractCaddyUrls(undefined)).toEqual([]);
		expect(extractCaddyUrls({})).toEqual([]);
	});

	test('ignores containers with no caddy labels', () => {
		expect(extractCaddyUrls({ 'com.docker.compose.project': 'foo' })).toEqual([]);
	});

	test('bare caddy address defaults to https (Caddy auto-HTTPS)', () => {
		expect(extractCaddyUrls({ caddy: 'whoami.example.com' })).toEqual([
			{ url: 'https://whoami.example.com', group: 'caddy' }
		]);
	});

	test('directive labels are ignored - only the bare site key is an address', () => {
		const out = extractCaddyUrls({
			caddy: 'app.example.com',
			'caddy.reverse_proxy': '{{upstreams 3001}}',
			'caddy.tls': 'internal'
		});
		expect(out).toEqual([{ url: 'https://app.example.com', group: 'caddy' }]);
	});

	test('caddy_N groups each yield their own URL (containers behind vpn)', () => {
		const out = extractCaddyUrls({
			caddy_0: 'prefix2.example.com',
			'caddy_0.reverse_proxy': '{{upstreams 8080}}',
			caddy_1: 'prefix3.example.com',
			'caddy_1.reverse_proxy': '{{upstreams 5055}}'
		});
		expect(out).toEqual([
			{ url: 'https://prefix2.example.com', group: 'caddy_0' },
			{ url: 'https://prefix3.example.com', group: 'caddy_1' }
		]);
	});

	test('comma-separated addresses in one value yield multiple URLs', () => {
		const out = extractCaddyUrls({ caddy: 'example.com, example.org, www.example.com' });
		expect(out.map((u) => u.url)).toEqual([
			'https://example.com',
			'https://example.org',
			'https://www.example.com'
		]);
	});

	test('explicit http:// scheme is preserved', () => {
		expect(extractCaddyUrls({ caddy: 'http://insecure.example.com' })).toEqual([
			{ url: 'http://insecure.example.com', group: 'caddy' }
		]);
	});

	test('explicit https:// scheme is preserved', () => {
		expect(extractCaddyUrls({ caddy: 'https://app.example.com' })[0].url).toBe(
			'https://app.example.com'
		);
	});

	test(':80 port implies http and is stripped', () => {
		expect(extractCaddyUrls({ caddy: 'plain.example.com:80' })[0].url).toBe(
			'http://plain.example.com'
		);
	});

	test(':443 port stays https and is stripped', () => {
		expect(extractCaddyUrls({ caddy: 'secure.example.com:443' })[0].url).toBe(
			'https://secure.example.com'
		);
	});

	test('a custom port keeps https and is preserved', () => {
		expect(extractCaddyUrls({ caddy: 'app.example.com:8443' })[0].url).toBe(
			'https://app.example.com:8443'
		);
	});

	test('a path matcher is appended, trailing wildcard stripped', () => {
		expect(extractCaddyUrls({ caddy: 'example.com/api/*' })[0].url).toBe(
			'https://example.com/api'
		);
	});

	test('snippet / named-matcher definitions are not addresses', () => {
		const out = extractCaddyUrls({
			caddy_0: '(snippet)',
			'caddy_0.tls': 'internal',
			caddy_1: 'site-a.com',
			'caddy_1.import': 'snippet'
		});
		expect(out).toEqual([{ url: 'https://site-a.com', group: 'caddy_1' }]);
	});

	test('port-only / wildcard placeholders are skipped', () => {
		expect(extractCaddyUrls({ caddy: ':8080' })).toEqual([]);
		expect(extractCaddyUrls({ caddy: '*' })).toEqual([]);
		expect(extractCaddyUrls({ caddy: ':443' })).toEqual([]);
	});

	test('duplicate addresses across keys are deduped', () => {
		const out = extractCaddyUrls({ caddy_0: 'dup.example.com', caddy_1: 'dup.example.com' });
		expect(out).toEqual([{ url: 'https://dup.example.com', group: 'caddy_0' }]);
	});
});
