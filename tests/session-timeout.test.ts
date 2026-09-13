/**
 * resolveSessionTimeout: 0 is the "never expire" sentinel (#1302), a valid value
 * passes through, and anything out of range falls back to the 24h default.
 */
import { describe, it, expect } from 'bun:test';
import {
	resolveSessionTimeout,
	cookieMaxAge,
	DEFAULT_SESSION_TIMEOUT,
	NEVER_EXPIRE_TIMEOUT,
	MAX_SESSION_TIMEOUT,
	MAX_COOKIE_MAX_AGE
} from '../src/lib/utils/session-timeout';

describe('resolveSessionTimeout', () => {
	it('maps 0 to the never-expire (~10 years) lifetime', () => {
		expect(resolveSessionTimeout(0)).toBe(NEVER_EXPIRE_TIMEOUT);
	});

	it('passes a valid in-range value through unchanged', () => {
		expect(resolveSessionTimeout(3600)).toBe(3600);
		expect(resolveSessionTimeout(MAX_SESSION_TIMEOUT)).toBe(MAX_SESSION_TIMEOUT);
	});

	it('falls back to the default for out-of-range / invalid values', () => {
		expect(resolveSessionTimeout(-5)).toBe(DEFAULT_SESSION_TIMEOUT);
		expect(resolveSessionTimeout(MAX_SESSION_TIMEOUT + 1)).toBe(DEFAULT_SESSION_TIMEOUT);
		expect(resolveSessionTimeout(null)).toBe(DEFAULT_SESSION_TIMEOUT);
		expect(resolveSessionTimeout(undefined)).toBe(DEFAULT_SESSION_TIMEOUT);
	});

	it('never-expire is far enough out to not practically time out', () => {
		// ~10 years in seconds - a session created now would outlast any real deployment
		expect(NEVER_EXPIRE_TIMEOUT).toBeGreaterThan(MAX_SESSION_TIMEOUT * 100);
	});
});

describe('cookieMaxAge', () => {
	it('caps the never-expire lifetime at the browser ~400-day limit', () => {
		expect(cookieMaxAge(NEVER_EXPIRE_TIMEOUT)).toBe(MAX_COOKIE_MAX_AGE);
	});

	it('passes a normal timeout through unchanged (below the cap)', () => {
		expect(cookieMaxAge(86400)).toBe(86400);
		expect(cookieMaxAge(MAX_SESSION_TIMEOUT)).toBe(MAX_SESSION_TIMEOUT);
	});
});
