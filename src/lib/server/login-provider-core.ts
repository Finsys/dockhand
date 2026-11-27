/**
 * Which authenticator a login request's `provider` value reaches. Anything that is not an
 * LDAP provider is the local login, so the local-login policy is decided on this result,
 * never on the raw string the client sent.
 */
export type LoginMethod = { kind: 'ldap'; configId?: number } | { kind: 'local' };

export function loginMethod(provider: unknown): LoginMethod {
	const p = typeof provider === 'string' ? provider : 'local';
	if (p.startsWith('ldap:')) return { kind: 'ldap', configId: parseInt(p.split(':')[1], 10) };
	if (p === 'ldap') return { kind: 'ldap' };
	return { kind: 'local' };
}

/** An LDAP config a login request names by id: only an enabled one may sign anybody in. */
export function usableLdapConfig<T extends { enabled?: boolean | null }>(config: T | null | undefined): T[] {
	return config && config.enabled ? [config] : [];
}
