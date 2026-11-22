/**
 * TLS options for an LDAP client. The server certificate is always verified; a configured
 * CA becomes the trust anchor (for a private directory CA) instead of turning checking off.
 * LDAP_TLS_SKIP_VERIFY=true is the operator's explicit way out for a directory whose
 * certificate cannot be fixed yet: it turns verification off and says so in the log.
 */
export function ldapTlsSkipVerify(raw: string | undefined = process.env.LDAP_TLS_SKIP_VERIFY): boolean {
	return raw?.trim().toLowerCase() === 'true';
}

let warned = false;

export function ldapTlsOptions(
	tlsCa: string | null | undefined,
	skipVerify: boolean = ldapTlsSkipVerify()
): { rejectUnauthorized: boolean; ca?: string[] } {
	if (skipVerify) {
		if (!warned) {
			warned = true;
			console.warn(
				'[LDAP] LDAP_TLS_SKIP_VERIFY=true: the directory server certificate is NOT verified. Anyone between Dockhand and the LDAP server can read the passwords of users signing in. Fix the certificate or the configured CA and remove this setting.'
			);
		}
		return { rejectUnauthorized: false };
	}
	return tlsCa ? { rejectUnauthorized: true, ca: [tlsCa] } : { rejectUnauthorized: true };
}
