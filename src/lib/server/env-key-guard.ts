/**
 * Strip environment keys that would change how Dockhand's own deploy subprocess
 * (docker / docker compose / git) finds and runs its binaries, before merging a
 * stack's user-supplied env vars into that subprocess's environment.
 *
 * A stack sets arbitrary env names for its CONTAINERS, so this is a denylist, not an
 * allowlist: only the handful of keys that steer the parent process's loader and PATH
 * are removed. Without it a stacks:edit user could set PATH (or LD_PRELOAD, etc.) so
 * `docker` resolves to a binary they control and runs as the server process.
 */

// Exact reserved keys: PATH and the dynamic-loader / shell-startup vars that decide
// which binary runs, plus the DOCKER_* names Dockhand sets itself to reach the daemon.
const RESERVED_EXACT = new Set([
	'PATH',
	'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT',
	'NODE_OPTIONS',
	'BASH_ENV', 'ENV', 'SHELLOPTS', 'IFS', 'SHELL',
	'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_EXEC_PATH',
	'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'DOCKER_CONTEXT'
]);

// Prefixes covering the whole dynamic-loader families (glibc LD_*, macOS DYLD_*).
const RESERVED_PREFIXES = ['LD_', 'DYLD_'];

function isReservedEnvKey(key: string): boolean {
	if (RESERVED_EXACT.has(key)) return true;
	return RESERVED_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Return a copy of vars with reserved keys removed. Applied at every seam that merges
 * stack env vars into the deploy subprocess env (compose local, compose legacy, and the
 * Hawser remote body), because secret values also arrive from external secret providers
 * and repo .env files, which never pass through the API key-name validator.
 */
export function stripReservedEnvKeys(vars: Record<string, string> | undefined | null): Record<string, string> {
	const out: Record<string, string> = {};
	if (!vars) return out;
	for (const [k, v] of Object.entries(vars)) {
		if (!isReservedEnvKey(k)) out[k] = v;
	}
	return out;
}
