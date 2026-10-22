import { describe, expect, test } from 'bun:test';
import {
	enforcesRoles,
	licenseValid,
	lapsed,
	nonAdminMayAct,
	type LicenseVerdict
} from '../src/lib/server/license-state-core';

// The shapes validateLicense really returns. It hands back the decoded payload even
// when it rejects the key, but only once the RSA signature has passed - which is what
// lets a lapse be told apart from a forgery.
const noLicense = null;
const enterpriseValid: LicenseVerdict = { valid: true, active: true, payload: { type: 'enterprise' } };
const enterpriseExpired: LicenseVerdict = { valid: false, active: false, payload: { type: 'enterprise' } };
const enterpriseWrongHost: LicenseVerdict = { valid: false, active: false, payload: { type: 'enterprise' } };
const smbValid: LicenseVerdict = { valid: true, active: true, payload: { type: 'smb' } };
const smbExpired: LicenseVerdict = { valid: false, active: false, payload: { type: 'smb' } };
const badSignature: LicenseVerdict = { valid: false, active: false };

describe('roles keep being enforced', () => {
	// The point of the split: an expiry must not turn authorization off. Dozens of
	// endpoints read this flag to decide environment access, so dropping it would
	// switch every one of those checks off at the same moment.
	test('while the license is valid', () => {
		expect(enforcesRoles(enterpriseValid)).toBe(true);
	});

	test('and after it expires', () => {
		expect(enforcesRoles(enterpriseExpired)).toBe(true);
	});

	test('and after the host is renamed', () => {
		expect(enforcesRoles(enterpriseWrongHost)).toBe(true);
	});

	test('but not on an instance that never had a license', () => {
		expect(enforcesRoles(noLicense)).toBe(false);
		expect(enforcesRoles(undefined)).toBe(false);
	});

	test('and not on SMB, which never unlocked roles', () => {
		expect(enforcesRoles(smbValid)).toBe(false);
		expect(enforcesRoles(smbExpired)).toBe(false);
	});

	test('and not on a key that fails its signature', () => {
		expect(enforcesRoles(badSignature)).toBe(false);
	});
});

describe('paid features follow the license, not the roles', () => {
	test('available while it validates', () => {
		expect(licenseValid(enterpriseValid)).toBe(true);
	});

	test('withdrawn once it expires', () => {
		// LDAP, the audit log and role editing stop; enforcement above does not.
		expect(licenseValid(enterpriseExpired)).toBe(false);
	});

	test('withdrawn when the host no longer matches', () => {
		expect(licenseValid(enterpriseWrongHost)).toBe(false);
	});

	test('never available without a license', () => {
		expect(licenseValid(noLicense)).toBe(false);
	});

	test('and an SMB license does not buy them', () => {
		expect(licenseValid(smbValid)).toBe(false);
	});
});

describe('who may act once a license has lapsed', () => {
	test('a lapse is an enterprise key that stopped validating', () => {
		expect(lapsed(enterpriseExpired)).toBe(true);
		expect(lapsed(enterpriseWrongHost)).toBe(true);
	});

	test('a working license is not a lapse', () => {
		expect(lapsed(enterpriseValid)).toBe(false);
	});

	test('nor is an instance that never had one', () => {
		expect(lapsed(noLicense)).toBe(false);
		expect(lapsed(undefined)).toBe(false);
	});

	test('nor an expired SMB license', () => {
		expect(lapsed(smbExpired)).toBe(false);
	});

	test('nor a key that cannot be verified', () => {
		// Locking the instance out on an unverifiable string would let anyone able to
		// write the setting deny service to everybody.
		expect(lapsed(badSignature)).toBe(false);
	});

	test('a non-admin is held during a lapse', () => {
		// The defect this closes: an expiry used to grant everyone full access.
		expect(nonAdminMayAct(enterpriseExpired)).toBe(false);
		expect(nonAdminMayAct(enterpriseWrongHost)).toBe(false);
	});

	test('and is not held in any other state', () => {
		expect(nonAdminMayAct(enterpriseValid)).toBe(true);
		expect(nonAdminMayAct(noLicense)).toBe(true);
		expect(nonAdminMayAct(smbExpired)).toBe(true);
		expect(nonAdminMayAct(badSignature)).toBe(true);
	});
});

describe('every paid feature is gated on the license, not on the roles', () => {
	// The trade this design makes: isEnterprise stays true through a lapse, so anything
	// that used it to decide whether a feature is SOLD has to move to hasValidLicense.
	// Missing one leaves a paid feature working on an expired license - which is how the
	// second copy of the audit routes under src/routes/audit/ was found.
	const { readFileSync, readdirSync, statSync } = require('node:fs') as typeof import('node:fs');

	function serverFiles(dir: string, acc: string[] = []): string[] {
		for (const entry of readdirSync(dir)) {
			const full = `${dir}/${entry}`;
			if (statSync(full).isDirectory()) serverFiles(full, acc);
			else if (entry === '+server.ts') acc.push(full);
		}
		return acc;
	}

	// Reads of isEnterprise that are enforcement, not selling: they scope access to an
	// environment, or decide whether roles exist at all, and must survive a lapse.
	const ENFORCEMENT = [
		'src/routes/api/roles/+server.ts', // GET: an admin still sees the roles
		'src/routes/api/roles/[id]/+server.ts',
		'src/routes/api/users/+server.ts' // free edition grants Admin to new users
	];

	test('no handler sells a feature off auth.isEnterprise', () => {
		const offenders: string[] = [];
		for (const file of serverFiles(new URL('../src/routes', import.meta.url).pathname)) {
			const rel = file.slice(file.indexOf('src/routes'));
			if (ENFORCEMENT.includes(rel)) continue;
			const src = readFileSync(file, 'utf8');
			// The shape that denies outright is the one that sells.
			if (/if \(!auth\.isEnterprise\) \{/.test(src)) offenders.push(rel);
		}
		expect(offenders).toEqual([]);
	});
});

describe('the three answers together', () => {
	// Read as a table, because the value of the split is in how the rows differ.
	const rows: [string, LicenseVerdict | null, boolean, boolean, boolean][] = [
		// state                  verdict               enforces  valid  lapsed
		['no license',            noLicense,            false,    false, false],
		['valid enterprise',      enterpriseValid,      true,     true,  false],
		['expired enterprise',    enterpriseExpired,    true,     false, true],
		['enterprise, wrong host', enterpriseWrongHost, true,     false, true],
		['valid SMB',             smbValid,             false,    false, false],
		['expired SMB',           smbExpired,           false,    false, false],
		['unverifiable key',      badSignature,         false,    false, false]
	];

	for (const [name, verdict, roles, paid, held] of rows) {
		test(name, () => {
			expect(enforcesRoles(verdict)).toBe(roles);
			expect(licenseValid(verdict)).toBe(paid);
			expect(lapsed(verdict)).toBe(held);
		});
	}
});
