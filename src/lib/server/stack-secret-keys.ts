/**
 * Pure helpers for the `stack_sources.injected_secret_keys` column - the names (no
 * values) of provider-injected secrets recorded on the last deploy so container
 * inspect can mask them. Kept dependency-free (no DB import) so it unit-tests without
 * spinning up the database.
 */

/**
 * Parses the stored JSON string[] of key names into a Set. Tolerates
 * null/empty/malformed/legacy values by returning an empty set (never throws), so a
 * bad row degrades to "nothing extra masked" rather than a 500. Non-string array
 * members are dropped.
 */
export function parseInjectedSecretKeys(raw: string | null | undefined): Set<string> {
	if (!raw) return new Set();
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? new Set(parsed.filter((k) => typeof k === 'string')) : new Set();
	} catch {
		return new Set();
	}
}

/**
 * Serialises the injected key names for storage: a JSON array, or null when empty so
 * an unbound / provider-less stack clears the column instead of storing `[]`.
 */
export function serializeInjectedSecretKeys(keys: string[]): string | null {
	return keys.length > 0 ? JSON.stringify(keys) : null;
}
