/**
 * Pure helpers for comparing Docker environment connection settings.
 * Kept separate from server modules so they can be unit-tested without DB access.
 */

export interface EnvironmentConnectionInput {
	connectionType: 'socket' | 'direct' | 'hawser-standard' | 'hawser-edge';
	socketPath?: string | null;
	host?: string | null;
	port?: number | null;
	protocol?: string | null;
	tlsCa?: string | null;
	tlsCert?: string | null;
	tlsKey?: string | null;
	tlsSkipVerify?: boolean | null;
	hawserToken?: string | null;
}

/**
 * Resolve a socket path to its canonical filesystem path when it exists.
 */
export function normalizeSocketPath(
	socketPath: string,
	exists: (path: string) => boolean = () => false,
	realpath: (path: string) => string = (path) => path
): string {
	try {
		if (exists(socketPath)) {
			return realpath(socketPath);
		}
	} catch {
		// Fall back to the literal path when resolution fails.
	}
	return socketPath;
}

/**
 * True when two socket configurations resolve to the same Unix socket.
 */
export function areSocketConfigsEquivalent(
	a: EnvironmentConnectionInput,
	b: EnvironmentConnectionInput,
	exists: (path: string) => boolean = () => false,
	realpath: (path: string) => string = (path) => path
): boolean {
	if ((a.connectionType || 'socket') !== 'socket' || (b.connectionType || 'socket') !== 'socket') {
		return false;
	}

	const pathA = normalizeSocketPath(a.socketPath || '/var/run/docker.sock', exists, realpath);
	const pathB = normalizeSocketPath(b.socketPath || '/var/run/docker.sock', exists, realpath);
	return pathA === pathB;
}

export const CONNECTION_FIELDS = [
	'connectionType',
	'socketPath',
	'host',
	'port',
	'protocol',
	'tlsCa',
	'tlsCert',
	'tlsKey',
	'tlsSkipVerify',
	'hawserToken'
] as const;

function normalizeConnectionFieldValue(
	field: (typeof CONNECTION_FIELDS)[number],
	value: unknown,
	cleanPem: (pem: string | null | undefined) => string | null
): unknown {
	if (field === 'tlsCa' || field === 'tlsCert' || field === 'tlsKey') {
		return cleanPem(value as string);
	}
	return value;
}

export function hasConnectionFieldChanges(
	oldValues: Record<string, unknown>,
	data: Record<string, unknown>,
	cleanPem: (pem: string | null | undefined) => string | null
): boolean {
	return CONNECTION_FIELDS.some((field) => {
		if (data[field] === undefined) return false;

		const newValue = normalizeConnectionFieldValue(field, data[field], cleanPem);
		return newValue !== oldValues[field];
	});
}

/**
 * Parse DOCKHAND_ALLOW_DUPLICATE_ENVS — when true/1, duplicate Docker daemon
 * validation is skipped (used by integration tests that share one daemon).
 */
export function allowDuplicateDockerEnvironmentsFromEnv(value: string | undefined): boolean {
	return value === 'true' || value === '1';
}
