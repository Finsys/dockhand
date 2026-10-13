import { describe, expect, test } from 'bun:test';
import { heldByLapsedLicence, licenceHoldMessage } from '../src/lib/utils/licence-hold';

/**
 * Who is told that a lapsed licence, rather than their own permissions, is what is
 * stopping them.
 *
 * A licence that stops validating refuses every read for everybody but an
 * administrator, so without one sentence at the top the whole application reads as
 * broken: empty tables, spinners that never resolve, requests that failed.
 */

const viewerOnHold = {
	hasEnterpriseLicense: true,
	isEnterprise: false,
	isAdmin: false,
	isAuthenticated: true
};

describe('an account that is held', () => {
	test('a non-admin on an instance whose licence stopped validating', () => {
		expect(heldByLapsedLicence(viewerOnHold)).toBe(true);
	});

	test('and is told which of the two it is', () => {
		// "Permission denied" everywhere is true but useless: nothing they can do
		// about their own role will change it.
		// Asserted exactly: a loose match passes for a message saying the opposite,
		// and a banner that reassures somebody who is locked out is worse than none.
		expect(licenceHoldMessage(viewerOnHold)).toBe(
			'This instance needs its licence renewed. Until then only administrators can make changes, so pages will look empty.'
		);
	});
});

describe('an account that is not', () => {
	test('an administrator, who is the one who fixes it', () => {
		expect(heldByLapsedLicence({ ...viewerOnHold, isAdmin: true })).toBe(false);
		expect(licenceHoldMessage({ ...viewerOnHold, isAdmin: true })).toBeNull();
	});

	test('anybody on a licence that still validates', () => {
		expect(heldByLapsedLicence({ ...viewerOnHold, isEnterprise: true })).toBe(false);
	});

	test('an instance that never had an enterprise licence', () => {
		// The free edition is not on hold; it simply never enforced roles.
		expect(
			heldByLapsedLicence({ ...viewerOnHold, hasEnterpriseLicense: false })
		).toBe(false);
	});

	test('nobody signed in, who is looking at a login page instead', () => {
		expect(heldByLapsedLicence({ ...viewerOnHold, isAuthenticated: false })).toBe(false);
	});

	test('anybody, while the licence and the account are still being read', () => {
		// They arrive in two separate requests. An administrator whose licence answers
		// first would otherwise be told, until the slower one lands, that they cannot
		// make changes - the opposite of what they need to see.
		expect(heldByLapsedLicence({ ...viewerOnHold, loading: true })).toBe(false);
		expect(
			heldByLapsedLicence({ ...viewerOnHold, isAdmin: true, loading: true })
		).toBe(false);
	});
});
