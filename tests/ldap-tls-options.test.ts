/**
 * LDAP over TLS always verifies the server certificate. A configured CA is the trust anchor
 * for a private directory CA; it must never be read as "skip verification".
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ldapTlsOptions, ldapTlsSkipVerify } from '../src/lib/server/ldap-tls';

const CA = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';

describe('ldapTlsOptions', () => {
	test('with a CA: verification stays on and the CA is the trust anchor', () => {
		expect(ldapTlsOptions(CA, false)).toEqual({ rejectUnauthorized: true, ca: [CA] });
	});

	test('without a CA: verification against the system roots', () => {
		expect(ldapTlsOptions(null, false)).toEqual({ rejectUnauthorized: true });
		expect(ldapTlsOptions('', false)).toEqual({ rejectUnauthorized: true });
	});

	test('LDAP_TLS_SKIP_VERIFY=true turns verification off, with or without a CA, and warns once', () => {
		const warn = console.warn;
		const lines: string[] = [];
		console.warn = (...a: unknown[]) => { lines.push(a.join(' ')); };
		try {
			expect(ldapTlsOptions(CA, true)).toEqual({ rejectUnauthorized: false });
			expect(ldapTlsOptions(null, true)).toEqual({ rejectUnauthorized: false });
		} finally {
			console.warn = warn;
		}
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('LDAP_TLS_SKIP_VERIFY=true');
		expect(lines[0]).toContain('NOT verified');
	});
});

test('the default reads LDAP_TLS_SKIP_VERIFY from the environment', () => {
	const before = process.env.LDAP_TLS_SKIP_VERIFY;
	try {
		process.env.LDAP_TLS_SKIP_VERIFY = 'true';
		expect(ldapTlsOptions(CA).rejectUnauthorized).toBe(false);
		delete process.env.LDAP_TLS_SKIP_VERIFY;
		expect(ldapTlsOptions(CA)).toEqual({ rejectUnauthorized: true, ca: [CA] });
	} finally {
		if (before === undefined) delete process.env.LDAP_TLS_SKIP_VERIFY;
		else process.env.LDAP_TLS_SKIP_VERIFY = before;
	}
});

describe('ldapTlsSkipVerify', () => {
	test('only an explicit true turns it on', () => {
		expect(ldapTlsSkipVerify('true')).toBe(true);
		expect(ldapTlsSkipVerify(' TRUE ')).toBe(true);
		for (const v of ['', 'false', '0', '1', 'yes', 'truee', 'no']) expect(ldapTlsSkipVerify(v)).toBe(false);
	});

	// auth.ts loads argon2 and cannot be imported under bun, so pin that every LDAP client
	// there builds its TLS options through the helper and none sets the flag by hand.
	test('every LDAP client in auth.ts uses the helper', () => {
		const src = readFileSync('src/lib/server/auth.ts', 'utf8');
		expect(src.match(/tlsOptions: config\.tlsEnabled \? ldapTlsOptions\(config\.tlsCa\) : undefined/g)?.length).toBe(4);
		expect(src).not.toContain('rejectUnauthorized');
		expect((src.match(/new LdapClient\(/g) ?? []).length).toBe(4);
	});
});
