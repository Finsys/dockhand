import { describe, test, expect } from 'bun:test';
import { extractPath, isSessionExpiryCandidate } from '../src/lib/utils/session-expiry';

const ORIGIN = 'https://dockhand.example.com';

describe('extractPath', () => {
	test('reads the path from a string url (relative or absolute)', () => {
		expect(extractPath('/api/containers', ORIGIN)).toBe('/api/containers');
		expect(extractPath('https://dockhand.example.com/api/stacks', ORIGIN)).toBe('/api/stacks');
	});

	test('reads the path from a URL object', () => {
		expect(extractPath(new URL('/api/images', ORIGIN), ORIGIN)).toBe('/api/images');
	});

	test('reads the path from a Request object (not its [object Request] string)', () => {
		expect(extractPath(new Request(`${ORIGIN}/api/networks`), ORIGIN)).toBe('/api/networks');
	});

	test('returns null when the origin itself is invalid (URL ctor throws)', () => {
		expect(extractPath('/api/containers', 'not-a-valid-origin')).toBeNull();
	});
});

describe('isSessionExpiryCandidate', () => {
	test('a 401 on a normal /api path is a candidate', () => {
		expect(isSessionExpiryCandidate(401, '/api/containers')).toBe(true);
		expect(isSessionExpiryCandidate(401, '/api/registry/image')).toBe(true);
	});

	test('non-401 statuses are never candidates', () => {
		expect(isSessionExpiryCandidate(200, '/api/containers')).toBe(false);
		expect(isSessionExpiryCandidate(403, '/api/containers')).toBe(false); // permission-denied, not expiry
		expect(isSessionExpiryCandidate(500, '/api/containers')).toBe(false);
	});

	test('auth endpoints are excluded (they 401 during normal auth flow)', () => {
		expect(isSessionExpiryCandidate(401, '/api/auth/session')).toBe(false);
		expect(isSessionExpiryCandidate(401, '/api/auth/login')).toBe(false);
		expect(isSessionExpiryCandidate(401, '/api/auth/logout')).toBe(false);
	});

	test('non-/api paths are excluded', () => {
		expect(isSessionExpiryCandidate(401, '/login')).toBe(false);
		expect(isSessionExpiryCandidate(401, '/containers')).toBe(false);
	});

	test('a null path (unparseable url) is never a candidate', () => {
		expect(isSessionExpiryCandidate(401, null)).toBe(false);
	});
});
