/**
 * Environment-name validation (#1179).
 *
 * Environment names end up in filesystem paths (e.g. $DATA_DIR/stacks/<name>/...
 * in stacks.ts:344) and occasionally in shell-formatted strings, so the name
 * has to be quote-safe and glob-free.
 *
 * The rule is permissive on purpose — strict alphanumeric would orphan
 * existing real-world env names like "rambo (ARM)" or "docker-websites".
 * Anything currently in the wild passes; only NEW characters that actively
 * cause breakage are rejected.
 */

// Allowed characters: ASCII letters/digits + _ . - ( ) space + @ '
// First char: any allowed except space (no leading whitespace).
// Last char: any allowed except space and dot (no trailing whitespace,
// no trailing dot to avoid Windows-style "hidden" trailing-dot issues).
// Length: 1..64.
// Apostrophe (#1228): safe — env.name only lands in path.join() and
// array-form spawn(), never in a shell-interpolated string.
export const ENV_NAME_RE = /^(?! )[A-Za-z0-9_.\-()' +@](?:[A-Za-z0-9_.\-()' +@]{0,62}[A-Za-z0-9_\-)'+@])?$/;

export const ENV_NAME_MAX_LENGTH = 64;

export interface ValidationResult {
	ok: boolean;
	reason?: string;
}

/**
 * Validate an environment name. Returns a structured result so callers can
 * decide how to surface the error (server: 400 body, client: inline message).
 */
export function validateEnvName(name: unknown): ValidationResult {
	if (typeof name !== 'string') return { ok: false, reason: 'Name is required' };
	if (name.length === 0) return { ok: false, reason: 'Name is required' };
	if (name.length > ENV_NAME_MAX_LENGTH) {
		return { ok: false, reason: `Name must be ${ENV_NAME_MAX_LENGTH} characters or fewer` };
	}
	if (!ENV_NAME_RE.test(name)) {
		return {
			ok: false,
			reason:
				'Name can\'t contain slashes, wildcards, or other shell-special characters, and can\'t start with whitespace or end with whitespace or a dot'
		};
	}
	return { ok: true };
}

/** Convenience boolean variant. */
export function isValidEnvName(name: unknown): boolean {
	return validateEnvName(name).ok;
}
