/**
 * The global newer-version settings: what an absent, partial or broken stored value means.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { semverConfigFromSetting, DEFAULT_SEMVER_CONFIG } from '../src/lib/server/semver/global-config';

// The settings an install that never saved any gets: detection off, any bump, same
// flavour, no prereleases, older builds not rejected.
const DEFAULTS = { enabled: false, maxBump: 'major', matchFlavor: true, includePrerelease: false, rejectOlderImages: false };

describe('semverConfigFromSetting', () => {
	test('ignoring older images is off unless chosen, since it can hide a real newer tag', () => {
		expect(semverConfigFromSetting(undefined).rejectOlderImages).toBe(false);
		// A config saved before the option existed has no field and gets the default.
		expect(semverConfigFromSetting(JSON.stringify({ enabled: true, maxBump: 'minor' })).rejectOlderImages).toBe(false);
	});

	test('a stored choice wins in either direction', () => {
		expect(semverConfigFromSetting(JSON.stringify({ rejectOlderImages: true })).rejectOlderImages).toBe(true);
		expect(semverConfigFromSetting(JSON.stringify({ rejectOlderImages: false })).rejectOlderImages).toBe(false);
		expect(semverConfigFromSetting(JSON.stringify({ enabled: true })).enabled).toBe(true);
	});

	test('an unreadable value falls back to the defaults', () => {
		expect(semverConfigFromSetting('{not json')).toEqual(DEFAULTS);
		expect(semverConfigFromSetting('')).toEqual(DEFAULTS);
		expect(DEFAULT_SEMVER_CONFIG).toEqual(DEFAULTS);
	});

	test('the stored settings are read through this function, with no second default', () => {
		// db.ts cannot load under bun, so its wiring is pinned by source.
		const db = readFileSync(new URL('../src/lib/server/db.ts', import.meta.url), 'utf8');
		expect(db).toContain('return semverConfigFromSetting(result[0]?.value);');
		expect(db).not.toMatch(/rejectOlderImages:\s*(true|false)/);
	});
});
