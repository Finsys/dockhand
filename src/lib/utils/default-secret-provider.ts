/**
 * The global default secret provider, stored as a settings row rather than a
 * column so no schema change is needed.
 *
 * The stored id is only a pointer: a provider can be deleted (or the row edited
 * by hand) while the setting still names it, so a default is resolved against
 * the live provider list and ignored when it no longer matches one.
 */
export const DEFAULT_SECRET_PROVIDER_SETTING = 'default_secret_provider_id';

/** Coerce a stored settings value to a provider id, or null if it names none. */
export function parseDefaultProviderId(raw: unknown): number | null {
	if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (!trimmed) return null;
		const parsed = Number(trimmed);
		return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
	}
	return null;
}

/**
 * The default to preselect, given the stored setting and the providers that
 * actually exist. Returns null when nothing is configured or the stored id is
 * stale, so a deleted provider silently falls back to no selection.
 */
export function resolveDefaultProviderId(
	raw: unknown,
	providers: Array<{ id: number }>
): number | null {
	const id = parseDefaultProviderId(raw);
	if (id === null) return null;
	return providers.some((p) => p.id === id) ? id : null;
}
