/**
 * Reading a session's provider column.
 *
 * A session records which OIDC provider issued it - `oidc:Keycloak` - so logging out
 * can end that provider's session too. LDAP, passkey and local sessions record the
 * bare kind, since nothing is ended at their end. Callers asking what sort of account
 * this is want the kind, not the name.
 */
export function providerKind(provider: string | null | undefined): 'local' | 'ldap' | 'oidc' | 'passkey' {
	if (!provider) return 'local';
	if (provider === 'oidc' || provider.startsWith('oidc:')) return 'oidc';
	if (provider === 'ldap' || provider.startsWith('ldap:')) return 'ldap';
	if (provider === 'passkey') return 'passkey';
	// An unrecognised value is treated as a local account: it grants nothing extra,
	// and the alternative is trusting a string nothing in the app writes.
	return 'local';
}

/** The provider name in an `oidc:<name>` session, or null for anything else. */
export function oidcProviderName(provider: string | null | undefined): string | null {
	if (!provider || !provider.startsWith('oidc:')) return null;
	const name = provider.slice('oidc:'.length);
	return name.length > 0 ? name : null;
}

/**
 * Whether this session's account authenticates somewhere else, so there is no local
 * password to confirm before a sensitive action.
 *
 * A skip-list rather than an allow-list of 'local': a session kind added later must
 * default to BEING asked for the password, not to bypassing it. A passkey session is
 * a local account that signed in differently, so it is not federated.
 */
export function isFederatedSession(provider: string | null | undefined): boolean {
	const kind = providerKind(provider);
	return kind === 'oidc' || kind === 'ldap';
}
