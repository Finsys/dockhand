/**
 * Which stored secrets a connection test may reuse. Editing an environment leaves the
 * hawserToken / tlsKey fields blank (the client never receives them), so Test connection
 * fills them from the saved environment - but only while the test still targets that
 * environment's own host, port and protocol. A changed target gets no stored secret.
 */
export interface TestTarget {
	host?: string;
	port?: number;
	protocol?: string;
	hawserToken?: string;
	tlsKey?: string;
}

export interface StoredTarget {
	host?: string | null;
	port?: number | null;
	protocol?: string | null;
	hawserToken?: string | null;
	tlsKey?: string | null;
}

export function fillStoredSecrets(config: TestTarget, stored: StoredTarget): void {
	const sameTarget =
		(config.host ?? '') === (stored.host ?? '') &&
		(config.port || 2375) === (stored.port || 2375) &&
		(config.protocol || 'http') === (stored.protocol || 'http');
	if (!sameTarget) return;
	if (!config.hawserToken) config.hawserToken = stored.hawserToken || undefined;
	if (!config.tlsKey) config.tlsKey = stored.tlsKey || undefined;
}
