/**
 * Keeping a deploy's resolved secret values off the wire.
 *
 * `deployStack()` returns the plaintext of every secret that reached the container, so
 * the deploy-history recorder can redact them out of compose's raw output. That same
 * result object is then answered to a webhook caller and streamed to the browser as an
 * SSE `result` event, and a secret must never ride along.
 *
 * A narrower return type does not prevent it: TypeScript checks excess properties only
 * on object literals, and `JSON.stringify` serializes whatever the object actually
 * holds. So the field is attached NON-ENUMERABLE instead, and the guarantee holds for
 * every caller at runtime - present for a direct read, absent from a stringify, a spread
 * and a structuredClone alike.
 */

/** The field's name, so a test can look for it without importing the deploy path. */
export const RESOLVED_SECRETS_KEY = 'resolvedSecrets';

/** Attach a deploy's secret values where only server code can see them. */
export function attachResolvedSecrets<T extends object>(result: T, secrets: string[]): T {
	Object.defineProperty(result, RESOLVED_SECRETS_KEY, {
		value: secrets,
		enumerable: false,
		writable: true,
		configurable: true
	});
	return result;
}
