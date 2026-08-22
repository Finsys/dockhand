import { describe, test, expect } from 'bun:test';
import { compareVersions, shouldShowWhatsNew } from '../src/lib/utils/version';

describe('compareVersions', () => {
	test('returns 0 for equal versions', () => {
		expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
	});

	test('handles v prefix', () => {
		expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
		expect(compareVersions('1.0.0', 'v1.0.0')).toBe(0);
		expect(compareVersions('v1.0.0', 'v1.0.0')).toBe(0);
	});

	test('returns 1 when v1 > v2', () => {
		expect(compareVersions('2.0.0', '1.0.0')).toBe(1);
		expect(compareVersions('1.1.0', '1.0.0')).toBe(1);
		expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
	});

	test('returns -1 when v1 < v2', () => {
		expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
		expect(compareVersions('1.0.0', '1.1.0')).toBe(-1);
		expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
	});

	test('handles different segment lengths', () => {
		expect(compareVersions('1.0', '1.0.0')).toBe(0);
		expect(compareVersions('1.0.0', '1.0')).toBe(0);
		expect(compareVersions('1.0', '1.0.1')).toBe(-1);
	});

	test('handles large version numbers', () => {
		expect(compareVersions('10.20.30', '10.20.29')).toBe(1);
		expect(compareVersions('1.0.100', '1.0.99')).toBe(1);
	});
});

describe('shouldShowWhatsNew', () => {
	test('returns false when currentVersion is null', () => {
		expect(shouldShowWhatsNew(null, null)).toBe(false);
	});

	test('returns false when currentVersion is "unknown"', () => {
		expect(shouldShowWhatsNew('unknown', null)).toBe(false);
	});

	test('returns true when lastSeenVersion is null (first time)', () => {
		expect(shouldShowWhatsNew('v1.0.0', null)).toBe(true);
	});

	test('returns true when current > lastSeen', () => {
		expect(shouldShowWhatsNew('v1.1.0', 'v1.0.0')).toBe(true);
	});

	test('returns false when current == lastSeen', () => {
		expect(shouldShowWhatsNew('v1.0.0', 'v1.0.0')).toBe(false);
	});

	test('returns false when current < lastSeen', () => {
		expect(shouldShowWhatsNew('v1.0.0', 'v1.1.0')).toBe(false);
	});
});
