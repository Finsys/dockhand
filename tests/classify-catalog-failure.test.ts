/**
 * Unit tests for classifyCatalogFailure (#873).
 *
 * GitLab/Harbor refuse /v2/_catalog to non-admins with a VALID token, returning
 * 401 + WWW-Authenticate error="insufficient_scope". That must NOT be reported as an
 * auth failure. A real bad token returns error="invalid_token". Verified empirically on
 * gitlab.com and a self-hosted GitLab (admin gets catalog=200, non-admin gets
 * insufficient_scope, bad token gets invalid_token).
 */
import { describe, test, expect } from 'bun:test';
import { classifyCatalogFailure } from '../src/lib/server/registry-catalog';

const WWW = (err: string) =>
	`Bearer realm="https://gitlab.com/jwt/auth",service="container_registry",scope="registry:catalog:*",error="${err}"`;

describe('classifyCatalogFailure', () => {
	test('insufficient_scope -> not_supported (valid token, catalog not permitted)', () => {
		expect(classifyCatalogFailure(401, WWW('insufficient_scope'), 'authed')).toBe('not_supported');
		// case-insensitive on the error value
		expect(classifyCatalogFailure(401, WWW('INSUFFICIENT_SCOPE'), 'anon')).toBe('not_supported');
	});

	test('invalid_token -> auth_failed (real bad/expired credentials)', () => {
		expect(classifyCatalogFailure(401, WWW('invalid_token'), 'authed')).toBe('auth_failed');
		expect(classifyCatalogFailure(401, WWW('invalid_token'), 'anon')).toBe('auth_failed');
	});

	test('authed + no error code -> not_supported (GitLab empty-scope token)', () => {
		// GitLab issues an empty-scope token; the challenge carries no error= code.
		expect(classifyCatalogFailure(401, 'Bearer realm="...",service="..."', 'authed')).toBe('not_supported');
		expect(classifyCatalogFailure(403, null, 'authed')).toBe('not_supported');
	});

	test('rejected (creds configured but token exchange failed) -> auth_failed', () => {
		// A bad/expired token makes getRegistryAuth return null despite creds being set;
		// that must surface as a real auth failure, not "not supported".
		expect(classifyCatalogFailure(401, 'Bearer realm="...",service="..."', 'rejected')).toBe('auth_failed');
		expect(classifyCatalogFailure(401, null, 'rejected')).toBe('auth_failed');
	});

	test('anonymous (no credentials) + no error code -> auth_failed', () => {
		// A plain 401 with no creds is the normal "log in" challenge.
		expect(classifyCatalogFailure(401, 'Bearer realm="...",service="..."', 'anon')).toBe('auth_failed');
		expect(classifyCatalogFailure(401, null, 'anon')).toBe('auth_failed');
	});

	test('explicit error code wins over the authState heuristic', () => {
		// invalid_token is a real failure even when authed
		expect(classifyCatalogFailure(401, WWW('invalid_token'), 'authed')).toBe('auth_failed');
		// insufficient_scope is not-supported even anonymously
		expect(classifyCatalogFailure(401, WWW('insufficient_scope'), 'anon')).toBe('not_supported');
	});
});
