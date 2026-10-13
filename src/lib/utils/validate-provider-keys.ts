/**
 * Treat keys a bound secret provider supplies as set when validating a compose file.
 *
 * `docker compose config` only asks whether a variable HAS a value, so a placeholder is
 * enough to stop it reporting `${VAR:?...}` as missing. Without this, Validate disagrees
 * with the deploy it is meant to preview: the deploy resolves the provider's bulk pull,
 * Validate does not, and every provider-supplied required variable comes back as an
 * error even though the stack deploys fine (#1621).
 *
 * Only key NAMES travel - the same names that already drive the editor's IN VAULT
 * markers - so no secret value reaches the browser or the validation command.
 */

/** Stand-in for a value only the provider knows. Never written anywhere. */
export const PLACEHOLDER = 'dockhand-provider-value';

/**
 * Whether a `docker compose config` error is about the placeholder rather than the
 * file.
 *
 * The placeholder satisfies `${VAR:?}`, but compose type-checks some fields, and no
 * single value fits them all: a port needs a number, `init:` needs a boolean. The real
 * value is a secret this preview never sees, so a complaint naming the placeholder says
 * nothing about whether the stack deploys - the deploy resolves the provider first.
 */
export function isPlaceholderArtefact(message: string): boolean {
	return message.includes(PLACEHOLDER);
}

/**
 * Names that steer the validation subprocess rather than the compose file. They reach it
 * as process environment, so a placeholder under one of these would break the run (a
 * clobbered PATH loses the docker binary) instead of standing in for a value. Compose
 * reads its own COMPOSE_* settings from the environment too.
 */
const RESERVED_KEYS = new Set([
	'PATH',
	'HOME',
	'IFS',
	'LD_PRELOAD',
	'LD_LIBRARY_PATH',
	'DYLD_INSERT_LIBRARIES',
	'NODE_OPTIONS',
	'DOCKER_HOST',
	'DOCKER_CONFIG',
	'DOCKER_CERT_PATH',
	'DOCKER_TLS_VERIFY',
	'DOCKER_CONTEXT'
]);

/** A provider key name safe to stand in for, as a shell variable the compose file reads. */
function isUsableKey(key: unknown): key is string {
	if (typeof key !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) return false;
	return !RESERVED_KEYS.has(key) && !key.startsWith('COMPOSE_');
}

/**
 * `envVars` with a placeholder added for every provider key that has no value yet.
 *
 * A real value always wins: an empty string is a deliberate setting, not an absence, so
 * only keys absent from `envVars` are filled. The input is left untouched.
 */
export function withProviderKeysAsSet(
	envVars: Record<string, string>,
	providerKeys: readonly string[] | null | undefined
): Record<string, string> {
	if (!providerKeys?.length) return { ...envVars };
	const out = { ...envVars };
	for (const key of providerKeys) {
		if (isUsableKey(key) && !(key in out)) out[key] = PLACEHOLDER;
	}
	return out;
}

/** Sanitize a provider-key list arriving over the wire. */
export function sanitizeProviderKeys(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter(isUsableKey))];
}
