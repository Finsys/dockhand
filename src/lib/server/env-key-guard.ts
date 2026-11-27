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
// which binary runs, the DOCKER_* names Dockhand sets itself to reach the daemon, and
// HOME / BUILDX_CONFIG, which decide where the docker CLI looks for its plugins.
const RESERVED_EXACT = new Set([
	'PATH', 'HOME', 'BUILDX_CONFIG',
	'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT',
	'NODE_OPTIONS',
	'BASH_ENV', 'ENV', 'SHELLOPTS', 'IFS', 'SHELL',
	'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_EXEC_PATH', 'GIT_PROXY_COMMAND',
	'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM',
	'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'DOCKER_CONTEXT'
]);

// Prefixes covering the dynamic-loader families (glibc LD_*, macOS DYLD_*) and git's
// configuration-by-environment family (GIT_CONFIG_COUNT with its GIT_CONFIG_KEY_<n> /
// GIT_CONFIG_VALUE_<n> pairs): a command-scope pair sets any config key, so a
// url.<base>.insteadOf rewrite steers a git child started for a git-remote include into
// running a program through the ext transport.
const RESERVED_PREFIXES = ['LD_', 'DYLD_', 'GIT_CONFIG_'];

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
