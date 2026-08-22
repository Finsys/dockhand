import { describe, it, expect } from 'bun:test';
import { escapeLdapFilterValue } from '../src/lib/server/ldap-filter';

// Unit test stays import-light: it must NOT pull in `ldapts` (whose transitive
// `whatwg-url` dep does not always link in the CI per-step node_modules).
// The "does the escaped filter actually PARSE via ldapts" proof lives in the
// integration test tests/ldap-filter-parse.test.ts, which runs with full node_modules.
describe('escapeLdapFilterValue - RFC 4515 filter escaping (LDAP group check)', () => {
	it("escapes a backslash so an AD DN with an escaped comma is safe in a filter (the reported bug)", () => {
		// CN=Surname\, Name,... - a real AD DN. Raw, ldapts reads `\,` as an invalid `\XX`
		// hex escape and throws "Invalid escaped hex character". Escaped (\\ -> \5c) it parses.
		const dn = 'CN=Surname\\, Name,OU=Group,OU=Users,DC=example,DC=com';
		const escaped = escapeLdapFilterValue(dn);
		expect(escaped).toContain('\\5c');            // backslash was hex-escaped
		expect(escaped).not.toContain('\\,');          // no bare backslash-comma left
	});
	it('escapes filter metacharacters ( ) * NUL', () => {
		expect(escapeLdapFilterValue('a(b)c*d')).toBe('a\\28b\\29c\\2ad');
		expect(escapeLdapFilterValue('x\0y')).toBe('x\\00y');
	});
	it('leaves a plain value untouched', () => {
		expect(escapeLdapFilterValue('CN=jsmith,OU=Users,DC=example,DC=com')).toBe('CN=jsmith,OU=Users,DC=example,DC=com');
	});
});
