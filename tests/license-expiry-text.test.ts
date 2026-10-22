import { describe, expect, test } from 'bun:test';
import {
	expiryText,
	daysLeft,
	shouldShowExpiryWarning,
	deriveLicenceFlags,
	licenceHeaderText
} from '../src/lib/utils/license-expiry-text';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * What the header tells somebody about the time they have left.
 *
 * Counting whole days rounds the last one up, so an hour and a full day read the same.
 * An administrator who reads "tomorrow" and plans to renew in the morning loses
 * enterprise features that afternoon, so the final day has to count down in real units.
 */

describe('the last day, where the wording decides whether somebody acts', () => {
	test('minutes left says minutes, not tomorrow', () => {
		expect(expiryText(10 * MINUTE)).toBe('License expires in 10 minutes');
		expect(expiryText(1 * MINUTE)).toBe('License expires in 1 minute');
	});

	test('under a minute still reads as a minute rather than zero', () => {
		// Rounding to 0 would say "expires in 0 minutes" on a licence that is still live.
		expect(expiryText(20 * 1000)).toBe('License expires in 1 minute');
	});

	test('hours left says hours', () => {
		expect(expiryText(3 * HOUR)).toBe('License expires in 3 hours');
		expect(expiryText(1 * HOUR)).toBe('License expires in 1 hour');
	});

	test('most of a day left is still hours, not tomorrow', () => {
		expect(expiryText(23 * HOUR)).toBe('License expires in 23 hours');
	});

	test('a part hour is not rounded up into time that is not there', () => {
		// Reporting more than is left is the failure this wording exists to remove.
		expect(expiryText(90 * MINUTE)).toBe('License expires in 1 hour');
		expect(expiryText(23 * HOUR + 59 * MINUTE)).toBe('License expires in 23 hours');
	});
});

describe('beyond the first day, whole days read better', () => {
	test('a day and a bit is tomorrow', () => {
		expect(expiryText(DAY + HOUR)).toBe('License expires tomorrow');
		expect(expiryText(DAY)).toBe('License expires tomorrow');
	});

	test('longer is counted in days', () => {
		expect(expiryText(2 * DAY)).toBe('License expires in 2 days');
		expect(expiryText(30 * DAY)).toBe('License expires in 30 days');
	});
});

describe('a licence that has run out', () => {
	test('says so plainly', () => {
		expect(expiryText(0)).toBe('License expired');
		expect(expiryText(-5 * MINUTE)).toBe('License expired');
		expect(expiryText(-10 * DAY)).toBe('License expired');
	});
});

describe('the day count that decides whether to warn at all', () => {
	test('the last day counts as one, so the banner still shows', () => {
		// The header only renders at 30 days or fewer; rounding the final day down to
		// zero would hide the warning exactly when it matters most.
		expect(daysLeft(10 * MINUTE)).toBe(1);
		expect(daysLeft(23 * HOUR)).toBe(1);
	});

	test('an expired licence is not a positive number of days', () => {
		expect(daysLeft(-1 * MINUTE)).toBeLessThanOrEqual(0);
	});

	test('whole days beyond the first', () => {
		expect(daysLeft(2 * DAY)).toBe(2);
		expect(daysLeft(30 * DAY)).toBe(30);
	});
});

describe('whether the header counts down at all', () => {
	const ent = { hasEnterpriseLicense: true, isEnterprise: true };

	test('a valid licence inside the warning window', () => {
		expect(shouldShowExpiryWarning({ ...ent, msRemaining: 10 * DAY })).toBe(true);
	});

	test('nothing to say while there is plenty of time left', () => {
		expect(shouldShowExpiryWarning({ ...ent, msRemaining: 90 * DAY })).toBe(false);
	});

	test('an expired licence still says so', () => {
		expect(
			shouldShowExpiryWarning({ hasEnterpriseLicense: true, isEnterprise: false, msRemaining: -2 * DAY })
		).toBe(true);
	});

	test('a licence that fails for some other reason still warrants a warning', () => {
		// Moved to a new host, key replaced: it is not working, and the person who can
		// fix it needs to know. What it SAYS is the reason rather than a countdown -
		// see licenceHeaderText below.
		expect(
			shouldShowExpiryWarning({
				hasEnterpriseLicense: true,
				isEnterprise: false,
				msRemaining: 10 * DAY
			})
		).toBe(true);
	});

	test('an instance with no enterprise licence has no countdown', () => {
		expect(
			shouldShowExpiryWarning({ hasEnterpriseLicense: false, isEnterprise: false, msRemaining: 5 * DAY })
		).toBe(false);
	});

	test('no expiry date at all', () => {
		expect(shouldShowExpiryWarning({ ...ent, msRemaining: null })).toBe(false);
	});
});

describe('reading the licence endpoint', () => {
	const future = '2099-01-01T00:00:00Z';

	test('a licence that validates', () => {
		const f = deriveLicenceFlags({ valid: true, active: true, payload: { type: 'enterprise', expires: future } });
		expect(f.isEnterprise).toBe(true);
		expect(f.hasEnterpriseLicense).toBe(true);
	});

	test('an expired one is still an enterprise licence that is installed', () => {
		// The two answer different questions: one gates the paid features, the other
		// decides whether there is anything to warn about at all.
		const f = deriveLicenceFlags({ valid: false, active: false, payload: { type: 'enterprise', expires: '2020-01-01T00:00:00Z' } });
		expect(f.isEnterprise).toBe(false);
		expect(f.hasEnterpriseLicense).toBe(true);
		expect(f.expiresAt).toBe('2020-01-01T00:00:00Z');
	});

	test('the reason a licence fails is carried through', () => {
		// It is the only thing that tells the header which failure this is, and the
		// only actionable half of the message.
		const f = deriveLicenceFlags({
			valid: false,
			active: false,
			error: 'License is not valid for this host (new.example.com)',
			payload: { type: 'enterprise', expires: future }
		});
		expect(f.problem).toBe('License is not valid for this host (new.example.com)');
	});

	test('a working licence has no problem to report', () => {
		const f = deriveLicenceFlags({ valid: true, active: true, error: null, payload: { type: 'enterprise', expires: future } });
		expect(f.problem).toBeNull();
	});

	test('one refused for its host keeps its future date', () => {
		// Moving the instance leaves a licence that fails while its date is still ahead.
		const f = deriveLicenceFlags({ valid: false, active: false, payload: { type: 'enterprise', expires: future } });
		expect(f.isEnterprise).toBe(false);
		expect(f.hasEnterpriseLicense).toBe(true);
		expect(f.expiresAt).toBe(future);
	});

	test('an SMB licence is not an enterprise one', () => {
		const f = deriveLicenceFlags({ valid: true, active: true, payload: { type: 'smb', expires: future } });
		expect(f.isEnterprise).toBe(false);
		expect(f.hasEnterpriseLicense).toBe(false);
		expect(f.isLicensed).toBe(true);
	});

	test('no licence at all', () => {
		const f = deriveLicenceFlags({ valid: false, active: false });
		expect(f).toEqual({
			isEnterprise: false,
			hasEnterpriseLicense: false,
			isLicensed: false,
			licenseType: null,
			expiresAt: null,
			problem: null
		});
	});
});

describe('what the header says about a licence', () => {
	const ent = { hasEnterpriseLicense: true, isEnterprise: true, problem: null };

	test('a working licence counts down inside the window', () => {
		expect(licenceHeaderText({ ...ent, msRemaining: 10 * DAY })).toBe('License expires in 10 days');
	});

	test('and says nothing while there is plenty of time', () => {
		expect(licenceHeaderText({ ...ent, msRemaining: 90 * DAY })).toBeNull();
	});

	test('an expired one says so', () => {
		expect(
			licenceHeaderText({ hasEnterpriseLicense: true, isEnterprise: false, msRemaining: -2 * DAY, problem: 'License has expired' })
		).toBe('License expired');
	});

	test('a licence refused for its host names the real reason', () => {
		// The date is still ahead, so counting down would promise days that do not
		// exist and send somebody to renew a licence that does not need renewing.
		expect(
			licenceHeaderText({
				hasEnterpriseLicense: true,
				isEnterprise: false,
				msRemaining: 10 * DAY,
				problem: 'License is not valid for this host (new.example.com)'
			})
		).toBe('License problem: License is not valid for this host (new.example.com)');
	});

	test('a licence that fails with no reason given still says something', () => {
		// Silence would leave the one person who can fix it with no signal at all.
		expect(
			licenceHeaderText({ hasEnterpriseLicense: true, isEnterprise: false, msRemaining: 10 * DAY, problem: null })
		).toBe('License is not valid');
	});

	test('a perpetual licence that works has nothing to report', () => {
		expect(licenceHeaderText({ ...ent, msRemaining: null })).toBeNull();
	});

	test('an instance with no enterprise licence is silent', () => {
		expect(
			licenceHeaderText({ hasEnterpriseLicense: false, isEnterprise: false, msRemaining: null, problem: null })
		).toBeNull();
	});
});
