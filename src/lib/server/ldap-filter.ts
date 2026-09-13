/**
 * Pure LDAP search-filter escaping (no server deps) - safe to import in unit tests.
 *
 * Escapes a value for use INSIDE an LDAP search filter per RFC 4515 (this is NOT DN/RFC
 * 4514 escaping). Critically it turns `\` into `\5c`, so a Distinguished Name placed into a
 * filter - e.g. `member=CN=Surname\, Name,OU=…` from Active Directory - doesn't make the
 * filter parser read `\,` as an invalid `\XX` hex escape and throw
 * ("Invalid escaped hex character"). The searchBase keeps the RAW DN; only filter VALUES
 * are escaped through this.
 */
export function escapeLdapFilterValue(value: string): string {
	return value
		.replace(/\\/g, '\\5c')
		.replace(/\*/g, '\\2a')
		.replace(/\(/g, '\\28')
		.replace(/\)/g, '\\29')
		.replace(/\0/g, '\\00');
}
