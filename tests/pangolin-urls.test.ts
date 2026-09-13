import { describe, expect, test } from 'bun:test';
import { extractPangolinUrls } from '../src/lib/utils/pangolin-urls';

/**
 * Scheme is decided by the `ssl` label ONLY (verified against Pangolin's source):
 *   ssl=true -> https, ssl=false -> http.
 *   ssl absent -> scope default: public = https, private = http.
 * The `protocol`/`mode` label is the resource TYPE, never the scheme, and is ignored.
 */
describe('extractPangolinUrls', () => {
	test('public resource, ssl=false -> http', () => {
		const out = extractPangolinUrls({
			'pangolin.public-resources.grafana.name': 'Grafana',
			'pangolin.public-resources.grafana.full-domain': 'grafana.example.com',
			'pangolin.public-resources.grafana.ssl': 'false',
			'pangolin.public-resources.grafana.targets[0].method': 'http',
			'pangolin.public-resources.grafana.targets[0].port': '3000'
		});
		expect(out).toEqual([
			{ url: 'http://grafana.example.com', resource: 'grafana', scope: 'public', displayName: 'Grafana' }
		]);
	});

	test('public resource, ssl=true -> https', () => {
		const out = extractPangolinUrls({
			'pangolin.public-resources.app.full-domain': 'app.example.com',
			'pangolin.public-resources.app.ssl': 'true'
		});
		expect(out[0].url).toBe('https://app.example.com');
	});

	test('public resource, ssl ABSENT -> https (public default)', () => {
		const out = extractPangolinUrls({
			'pangolin.public-resources.app.full-domain': 'app.example.com'
		});
		expect(out).toEqual([
			{ url: 'https://app.example.com', resource: 'app', scope: 'public', displayName: undefined }
		]);
	});

	test('the reporter case (#1331): protocol=http but ssl absent -> https, protocol ignored', () => {
		// protocol is the resource TYPE, not the scheme. A public resource with a
		// full-domain and no ssl label is https regardless of protocol=http.
		const out = extractPangolinUrls({
			'pangolin.public-resources.r.protocol': 'http',
			'pangolin.public-resources.r.full-domain': 'sub.domain.tld'
		});
		expect(out[0].url).toBe('https://sub.domain.tld');
	});

	test('protocol=http with an explicit ssl=false -> http (ssl wins, not protocol)', () => {
		const out = extractPangolinUrls({
			'pangolin.public-resources.r.protocol': 'http',
			'pangolin.public-resources.r.ssl': 'false',
			'pangolin.public-resources.r.full-domain': 'r.example.com'
		});
		expect(out[0].url).toBe('http://r.example.com');
	});

	test('private resource, ssl ABSENT -> http (private default)', () => {
		const out = extractPangolinUrls({
			'pangolin.private-resources.internal.full-domain': 'internal.lan'
		});
		expect(out).toEqual([
			{ url: 'http://internal.lan', resource: 'internal', scope: 'private', displayName: undefined }
		]);
	});

	test('private resource, ssl=true -> https', () => {
		const out = extractPangolinUrls({
			'pangolin.private-resources.internal.full-domain': 'internal.lan',
			'pangolin.private-resources.internal.ssl': 'true'
		});
		expect(out[0].url).toBe('https://internal.lan');
	});

	test('unparseable ssl value falls back to the scope default', () => {
		// public default = https
		const pub = extractPangolinUrls({
			'pangolin.public-resources.r.full-domain': 'r.example.com',
			'pangolin.public-resources.r.ssl': 'gibberish'
		});
		expect(pub[0].url).toBe('https://r.example.com');
		// private default = http
		const priv = extractPangolinUrls({
			'pangolin.private-resources.r.full-domain': 'r.lan',
			'pangolin.private-resources.r.ssl': 'gibberish'
		});
		expect(priv[0].url).toBe('http://r.lan');
	});

	test('ssl value is case-insensitive', () => {
		const out = extractPangolinUrls({
			'pangolin.public-resources.r.full-domain': 'r.example.com',
			'pangolin.public-resources.r.ssl': '  FALSE  '
		});
		expect(out[0].url).toBe('http://r.example.com');
	});

	test('multiple resources on the same container yield multiple URLs', () => {
		const out = extractPangolinUrls({
			'pangolin.public-resources.a.full-domain': 'a.example.com',
			'pangolin.public-resources.b.full-domain': 'b.example.com',
			'pangolin.public-resources.b.ssl': 'false'
		});
		expect(out).toHaveLength(2);
		const urls = out.map((p) => p.url).sort();
		expect(urls).toEqual(['http://b.example.com', 'https://a.example.com']);
	});

	test('same resource name under both scopes is treated as two resources', () => {
		const out = extractPangolinUrls({
			'pangolin.public-resources.dual.full-domain': 'pub.example.com',
			'pangolin.private-resources.dual.full-domain': 'priv.lan'
		});
		expect(out).toHaveLength(2);
		const scopes = out.map((p) => p.scope).sort();
		expect(scopes).toEqual(['private', 'public']);
		// And each gets its scope default scheme.
		expect(out.find((p) => p.scope === 'public')!.url).toBe('https://pub.example.com');
		expect(out.find((p) => p.scope === 'private')!.url).toBe('http://priv.lan');
	});

	test('skips resources with no full-domain', () => {
		const out = extractPangolinUrls({
			'pangolin.public-resources.no-domain.name': 'Incomplete',
			'pangolin.public-resources.no-domain.ssl': 'false'
		});
		expect(out).toEqual([]);
	});

	test('dedupes identical URLs across resources', () => {
		const out = extractPangolinUrls({
			'pangolin.public-resources.x.full-domain': 'same.example.com',
			'pangolin.public-resources.y.full-domain': 'same.example.com'
		});
		expect(out).toHaveLength(1);
	});

	test('ignores unrelated labels including legacy pangolin.proxy-resources.*', () => {
		const out = extractPangolinUrls({
			'org.opencontainers.image.source': 'https://github.com/foo/bar',
			'dockhand.url': 'https://example.com',
			'traefik.http.routers.x.rule': 'Host(`x.example.com`)',
			'pangolin.proxy-resources.r.full-domain': 'should-be-ignored.example.com',
			'pangolin.public-resources.r.full-domain': 'r.example.com'
		});
		expect(out).toEqual([
			{ url: 'https://r.example.com', resource: 'r', scope: 'public', displayName: undefined }
		]);
	});

	test('whitespace in the full-domain is trimmed', () => {
		const out = extractPangolinUrls({
			'pangolin.public-resources.s.full-domain': '  spaced.example.com  ',
			'pangolin.public-resources.s.ssl': 'false'
		});
		expect(out[0].url).toBe('http://spaced.example.com');
	});

	test('null / empty inputs return empty array', () => {
		expect(extractPangolinUrls(null)).toEqual([]);
		expect(extractPangolinUrls(undefined)).toEqual([]);
		expect(extractPangolinUrls({})).toEqual([]);
	});

	test('targets[N].* labels do not introduce extra resources', () => {
		const out = extractPangolinUrls({
			'pangolin.public-resources.grafana.full-domain': 'grafana.example.com',
			'pangolin.public-resources.grafana.targets[0].method': 'http',
			'pangolin.public-resources.grafana.targets[0].port': '3000'
		});
		expect(out).toHaveLength(1);
		expect(out[0].resource).toBe('grafana');
	});
});
