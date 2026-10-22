import { describe, test, expect } from 'bun:test';
import {
	supportsPercentageWarnings,
	percentageOptionDisabled,
	poolSizeBytes
} from '../src/lib/utils/disk-percentage-support';

// Verified against a live daemon (Docker 20.10.24, overlay2): these are the keys it
// actually returns, not an invented shape.
const OVERLAY2 = [
	['Backing Filesystem', 'extfs'],
	['Supports d_type', 'true'],
	['Native Overlay Diff', 'true'],
	['userxattr', 'false']
];

const DEVICEMAPPER = [
	['Pool Name', 'docker-8:1-pool'],
	['Data Space Used', '2.5 GB'],
	['Data Space Total', '107.4 GB']
];

describe('whether percentage warnings can fire', () => {
	test('a host reporting a pool size supports them', () => {
		expect(supportsPercentageWarnings(DEVICEMAPPER)).toBe(true);
	});

	// The case the whole issue is about: the default mode on the default driver.
	test('overlay2 does not, so the mode is dead there', () => {
		expect(supportsPercentageWarnings(OVERLAY2)).toBe(false);
	});

	test('a key with no value is the same as no key', () => {
		expect(supportsPercentageWarnings([['Data Space Total', '']])).toBe(false);
		expect(supportsPercentageWarnings([['Data Space Total', '   ']])).toBe(false);
	});

	test('an empty status reports no support', () => {
		expect(supportsPercentageWarnings([])).toBe(false);
	});

	// A host that could not be asked is UNKNOWN, never unsupported: an outage must
	// not take an option away from somebody.
	test('a host that could not be asked is unknown, not unsupported', () => {
		expect(supportsPercentageWarnings(null)).toBeNull();
		expect(supportsPercentageWarnings(undefined)).toBeNull();
		expect(supportsPercentageWarnings('nonsense')).toBeNull();
		expect(supportsPercentageWarnings({ 'Data Space Total': '10 GB' })).toBeNull();
	});

	test('a malformed entry is skipped rather than throwing', () => {
		expect(supportsPercentageWarnings([null, ['x'], ['Data Space Total', '1 GB']])).toBe(true);
		expect(supportsPercentageWarnings([null, ['x']])).toBe(false);
	});
});

describe('when the percentage option is unselectable', () => {
	// The escape hatch must survive being used: gating on the live form value would
	// disable the option the instant somebody switched away, trapping their own click.
	test('switching away from a stored percentage does not lock it out', () => {
		expect(percentageOptionDisabled(false, 'percentage')).toBe(false);
	});

	test('an unsupported host hides it from anyone not already using it', () => {
		expect(percentageOptionDisabled(false, 'absolute')).toBe(true);
		expect(percentageOptionDisabled(false, null)).toBe(true);
	});

	// A host that could not be asked must not have a setting taken away.
	test('a supported or unknown host never disables it', () => {
		expect(percentageOptionDisabled(true, 'absolute')).toBe(false);
		expect(percentageOptionDisabled(null, 'absolute')).toBe(false);
		expect(percentageOptionDisabled(undefined, 'absolute')).toBe(false);
	});
});

describe('a size the collector would refuse to divide by', () => {
	// The collector parses the value and requires a positive result, so a value it
	// would reject must not be advertised here as a working denominator.
	const withPoolSize = (value: unknown) => [['Data Space Total', value]];

	test('a zero pool is not support', () => {
		expect(supportsPercentageWarnings(withPoolSize('0 B'))).toBe(false);
	});

	test('a value in no recognised unit is not support', () => {
		expect(supportsPercentageWarnings(withPoolSize('unknown'))).toBe(false);
	});

	test('a real size still is', () => {
		expect(supportsPercentageWarnings(withPoolSize('107.4 GB'))).toBe(true);
	});

	test('poolSizeBytes agrees with the collector on the units it accepts', () => {
		expect(poolSizeBytes('1 KB')).toBe(1024);
		expect(poolSizeBytes('2 GB')).toBe(2 * 1024 ** 3);
		expect(poolSizeBytes('10.5 MB')).toBe(10.5 * 1024 ** 2);
		expect(poolSizeBytes('')).toBe(0);
		expect(poolSizeBytes(null)).toBe(0);
	});

	test('a padded value is refused, exactly as the collector refuses it', () => {
		// Being more forgiving here would reinstate the disagreement this function
		// exists to remove, in the opposite direction.
		expect(poolSizeBytes(' 5 GB')).toBe(0);
		expect(poolSizeBytes('5 GB ')).toBe(0);
	});

	test('a unit outside the collector table is refused', () => {
		expect(poolSizeBytes('1 PB')).toBe(0);
		expect(poolSizeBytes('-1 GB')).toBe(0);
	});
});
