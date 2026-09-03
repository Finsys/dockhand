/**
 * Redact secret VALUES out of free text (compose stderr/stdout) before it reaches
 * a less-trusted sink: a notification channel, the DB errorMessage, or the client
 * response. A deploy that fails while interpolating a secret (e.g. a container whose
 * command echoes ${DB_PASSWORD}) can print the plaintext value to stderr; without
 * this it would be delivered verbatim to an operator-configured webhook/email,
 * crossing the secrets:view boundary.
 *
 * Pure (no db/docker imports) so it is unit-testable in isolation.
 */

const REDACTED = '[REDACTED]';

/**
 * Replace every occurrence of each secret value in `text` with `[REDACTED]`.
 * Values shorter than 4 chars are skipped: they are too short to be a real
 * credential and matching them would corrupt ordinary output (e.g. a value of
 * "1" would redact every digit). Longest values are replaced first so a value
 * that contains another is fully masked.
 */
export function redactSecretValues(text: string, secretValues: Iterable<string>): string {
	if (!text) return text;
	const values = Array.from(new Set(Array.from(secretValues).filter((v) => v && v.length >= 4)));
	if (values.length === 0) return text;
	values.sort((a, b) => b.length - a.length);
	let out = text;
	for (const value of values) {
		out = out.split(value).join(REDACTED);
	}
	return out;
}

/** Convenience: redact the values of a secret-vars map from `text`. */
export function redactSecretVars(text: string, secretVars?: Record<string, string>): string {
	if (!secretVars) return text;
	return redactSecretValues(text, Object.values(secretVars));
}
