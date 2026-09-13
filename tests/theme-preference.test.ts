import { describe, it, expect } from 'bun:test';
import { resolveToggleValue, preferenceTarget, shouldSkipApply } from '../src/lib/utils/theme-preference';

describe('resolveToggleValue', () => {
	it('shows the global default when one is provided (General editor)', () => {
		expect(resolveToggleValue(true, false)).toBe(true);
		expect(resolveToggleValue(false, true)).toBe(false);
	});
	it('shows the store (personal) value when no global is provided', () => {
		expect(resolveToggleValue(undefined, true)).toBe(true);
		expect(resolveToggleValue(undefined, false)).toBe(false);
	});
	it('a global value of false is respected, not treated as "unset"', () => {
		// The guard is `!== undefined`, so `false` is a real global default, not a fallthrough.
		expect(resolveToggleValue(false, true)).toBe(false);
	});
});

describe('preferenceTarget', () => {
	it('saves to the profile (PUT) for a per-user preference', () => {
		expect(preferenceTarget(42)).toEqual({ url: '/api/profile/preferences', method: 'PUT' });
	});
	it('saves to the global default (POST) when no user id is given', () => {
		expect(preferenceTarget(undefined)).toEqual({ url: '/api/settings/general', method: 'POST' });
	});
});

describe('shouldSkipApply', () => {
	it('skips while auth state is still loading', () => {
		expect(shouldSkipApply(true, false, undefined)).toBe(true);
		expect(shouldSkipApply(true, true, 42)).toBe(true);
	});
	it('skips a global edit when auth is on (admin keeps their own view)', () => {
		expect(shouldSkipApply(false, true, undefined)).toBe(true);
	});
	it('applies a per-user edit even with auth on', () => {
		expect(shouldSkipApply(false, true, 42)).toBe(false);
	});
	it('applies a global edit when auth is off (store is the global value)', () => {
		expect(shouldSkipApply(false, false, undefined)).toBe(false);
	});
});
