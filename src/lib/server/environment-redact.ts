/**
 * Strip an environment's decrypted secrets before it leaves the server.
 *
 * `getEnvironment(s)` decrypt `tlsKey` (the private TLS client key) and `hawserToken`
 * for internal use, but neither must ever reach an API response: the TLS key
 * authenticates directly against the Docker daemon, bypassing Dockhand entirely and
 * surviving a revoked login. `tlsCa`/`tlsCert` are the public CA + client cert and
 * are NOT secret, so they stay. In their place we expose `hasTlsKey` / `hasHawserToken`
 * booleans so the UI can show "configured" without holding the value.
 */

/** The two secret fields removed from every environment API response. */
export type EnvironmentSecretField = 'tlsKey' | 'hawserToken';

export function redactEnvironment<T extends { tlsKey?: string | null; hawserToken?: string | null }>(
	env: T
): Omit<T, EnvironmentSecretField> & { hasTlsKey: boolean; hasHawserToken: boolean } {
	const { tlsKey, hawserToken, ...rest } = env;
	return {
		...rest,
		hasTlsKey: !!(tlsKey && tlsKey.length > 0),
		hasHawserToken: !!(hawserToken && hawserToken.length > 0)
	};
}
