/**
 * Unit tests for describeRegistryFailure (#1486): the update check reports the actual
 * reason a registry lookup failed instead of a generic "Could not query registry".
 */
import { describe, test, expect } from 'bun:test';
import { describeRegistryFailure } from '../src/lib/server/registry-failure-core';

/** Shape of the error fetch throws: TypeError('fetch failed') with the socket error as cause. */
const fetchError = (code: string, message = code) =>
	Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), { code }) });

const err = (error: unknown) => describeRegistryFailure({ kind: 'error', registry: 'ghcr.io', error });

describe('describeRegistryFailure - HTTP status', () => {
	test('429 with and without Retry-After', () => {
		expect(describeRegistryFailure({ kind: 'http', status: 429, retryAfter: '3600' })).toBe(
			'Rate limited by registry (429, retry after 3600s)'
		);
		expect(describeRegistryFailure({ kind: 'http', status: 429, retryAfter: null })).toBe('Rate limited by registry (429)');
	});

	test('Retry-After as HTTP-date is kept, anything odd is dropped', () => {
		expect(describeRegistryFailure({ kind: 'http', status: 429, retryAfter: 'Wed, 21 Oct 2026 07:28:00 GMT' })).toBe(
			'Rate limited by registry (429, retry after Wed, 21 Oct 2026 07:28:00 GMT)'
		);
		expect(describeRegistryFailure({ kind: 'http', status: 429, retryAfter: '<script>x</script>' })).toBe(
			'Rate limited by registry (429)'
		);
	});

	test('404 does not claim to know why the image is missing', () => {
		const msg = describeRegistryFailure({ kind: 'http', status: 404 });
		expect(msg).toContain('404');
		expect(msg).toContain('locally built');
	});

	test('401 / 403 -> access denied', () => {
		expect(describeRegistryFailure({ kind: 'http', status: 401 })).toContain('denied access (401)');
		expect(describeRegistryFailure({ kind: 'http', status: 403 })).toContain('denied access (403)');
	});

	test('5xx and other statuses keep the status code', () => {
		expect(describeRegistryFailure({ kind: 'http', status: 503 })).toBe('Registry server error (503)');
		expect(describeRegistryFailure({ kind: 'http', status: 400 })).toBe('Could not query registry (400)');
	});
});

describe('describeRegistryFailure - non-HTTP', () => {
	test('blocked host and missing digest header', () => {
		expect(describeRegistryFailure({ kind: 'blocked-host', registry: '169.254.169.254' })).toContain('169.254.169.254');
		expect(describeRegistryFailure({ kind: 'no-digest' })).toContain('Docker-Content-Digest');
	});

	test('DNS failures name the registry', () => {
		expect(err(fetchError('ENOTFOUND'))).toBe('DNS resolution failed for ghcr.io');
		expect(err(fetchError('EAI_AGAIN'))).toBe('DNS resolution failed for ghcr.io');
		expect(err(new Error('getaddrinfo EAI_AGAIN ghcr.io'))).toBe('DNS resolution failed for ghcr.io');
	});

	test('TLS against an HTTP-only registry points at the http:// setting', () => {
		expect(err(fetchError('ERR_SSL_WRONG_VERSION_NUMBER'))).toContain('HTTP-only');
		expect(err(fetchError('EPROTO'))).toContain('HTTP-only');
		expect(err(new Error('SSL routines:ssl3_get_record:wrong version number'))).toContain('HTTP-only');
	});

	test('untrusted certificate', () => {
		expect(err(fetchError('DEPTH_ZERO_SELF_SIGNED_CERT'))).toBe(
			'TLS certificate not trusted for ghcr.io (DEPTH_ZERO_SELF_SIGNED_CERT)'
		);
	});

	test('connection failures', () => {
		expect(err(fetchError('ECONNREFUSED'))).toBe('Registry unreachable: ghcr.io (ECONNREFUSED)');
		expect(err(fetchError('UND_ERR_CONNECT_TIMEOUT'))).toBe('Registry unreachable: ghcr.io (UND_ERR_CONNECT_TIMEOUT)');
	});

	test('unknown errors stay generic, with a code when there is one', () => {
		expect(err(new Error('boom'))).toBe('Could not query registry');
		expect(err(fetchError('ESOMETHING'))).toBe('Could not query registry (ESOMETHING)');
		expect(err(undefined)).toBe('Could not query registry');
	});
});

// Error shapes produced by Node's fetch (undici), which is what the app runs on. Bun's
// fetch reports different codes, so these are replayed rather than produced live.
describe('describeRegistryFailure - Node fetch error shapes', () => {
	test('HTTPS against a plain-HTTP server', () => {
		const e = fetchError(
			'ERR_SSL_WRONG_VERSION_NUMBER',
			'0A00010B:SSL routines:tls_validate_record_header:wrong version number'
		);
		expect(err(e)).toContain('HTTP-only');
	});

	test('refused on every resolved address (AggregateError cause)', () => {
		const agg = Object.assign(new AggregateError([Object.assign(new Error('connect ECONNREFUSED ::1:5000'), { code: 'ECONNREFUSED' })]), {
			code: 'ECONNREFUSED'
		});
		expect(err(Object.assign(new TypeError('fetch failed'), { cause: agg }))).toBe('Registry unreachable: ghcr.io (ECONNREFUSED)');
	});

	test('connection refused and connect timeout', () => {
		expect(err(fetchError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5000'))).toContain('Registry unreachable');
		expect(err(fetchError('UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error'))).toContain('Registry unreachable');
	});

	test('unknown host', () => {
		expect(err(fetchError('ENOTFOUND', 'getaddrinfo ENOTFOUND registry.example.invalid'))).toBe(
			'DNS resolution failed for ghcr.io'
		);
	});
});
