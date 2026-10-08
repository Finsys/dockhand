/**
 * Whether the login page offers passkey sign-in.
 *
 * Two things have to hold: an administrator allowed it, and the deployment can run a
 * WebAuthn ceremony at all. Either one missing means the button must not appear - a
 * button that cannot work costs the user a cancelled browser prompt and explains
 * nothing.
 */

import { describe, expect, test } from 'bun:test';
import { passkeysEnabledFromSetting, passkeysOffered } from '../src/lib/utils/passkey-availability';

describe('when passkeys are offered', () => {
	test('both conditions hold', () => {
		expect(passkeysOffered({ enabled: true, originUsable: true })).toBe(true);
	});

	test('the administrator switched it off', () => {
		expect(passkeysOffered({ enabled: false, originUsable: true })).toBe(false);
	});

	test('ORIGIN cannot support a ceremony', () => {
		// On by intent, inert in practice: ORIGIN missing, or http on a real host.
		expect(passkeysOffered({ enabled: true, originUsable: false })).toBe(false);
	});

	test('neither holds', () => {
		expect(passkeysOffered({ enabled: false, originUsable: false })).toBe(false);
	});
});

describe('reading the stored setting', () => {
	// Passkeys need an ORIGIN the deployment may not have, so an instance opts in
	// rather than being opted in for it.
	test('absent means off', () => {
		expect(passkeysEnabledFromSetting(null)).toBe(false);
		expect(passkeysEnabledFromSetting(undefined)).toBe(false);
	});

	test('an explicit true is the only thing that enables', () => {
		expect(passkeysEnabledFromSetting(true)).toBe(true);
	});

	test('an explicit false disables', () => {
		expect(passkeysEnabledFromSetting(false)).toBe(false);
	});

	test('an unreadable value does not enable', () => {
		// getSetting hands back whatever parsed, or the raw string when it did not.
		// None of these is a deliberate "on", so none may offer the sign-in method.
		for (const junk of ['true', 'false', 1, 0, '', 'nonsense', {}, [], NaN]) {
			expect(passkeysEnabledFromSetting(junk)).toBe(false);
		}
	});
});

describe('the two inputs are independent', () => {
	// Neither input may stand in for the other: an administrator's "on" must not be
	// read as "and therefore configured", and a usable ORIGIN must not imply consent.
	const states = [
		{ enabled: true, originUsable: true, offered: true },
		{ enabled: true, originUsable: false, offered: false },
		{ enabled: false, originUsable: true, offered: false },
		{ enabled: false, originUsable: false, offered: false }
	];

	test('every combination is accounted for', () => {
		for (const s of states) {
			expect(passkeysOffered(s)).toBe(s.offered);
		}
		expect(states.filter((s) => s.offered)).toHaveLength(1);
	});
});
