import { describe, test, expect } from 'bun:test';
import { frameProtectionEnabled } from '../src/lib/server/frame-protection-core';

describe('frameProtectionEnabled', () => {
	test('protected by default (unset / empty)', () => {
		expect(frameProtectionEnabled(undefined)).toBe(true);
		expect(frameProtectionEnabled(null)).toBe(true);
		expect(frameProtectionEnabled('')).toBe(true);
	});

	test('disabled only by a truthy opt-out (true / 1)', () => {
		expect(frameProtectionEnabled('true')).toBe(false);
		expect(frameProtectionEnabled('1')).toBe(false);
	});

	test('a non-truthy value keeps protection on (false / 0 / yes / garbage)', () => {
		// Strict parse mirrors csrfOriginCheckDisabled: only 'true'/'1' opt out, so a
		// mistyped value fails SAFE (protection stays on) rather than silently disabling it.
		expect(frameProtectionEnabled('false')).toBe(true);
		expect(frameProtectionEnabled('0')).toBe(true);
		expect(frameProtectionEnabled('yes')).toBe(true);
		expect(frameProtectionEnabled('TRUE')).toBe(true);
		expect(frameProtectionEnabled('nonsense')).toBe(true);
	});
});
