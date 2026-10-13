/**
 * Parse the `?env=` query param that scopes a name-keyed API endpoint to an
 * environment. Null (omit the param) targets the local/default environment.
 * Shared by the tag/icon endpoints so the parse is defined once.
 */
export function parseEnvParam(raw: string | null): number | null {
	if (!raw) return null;
	const n = Number.parseInt(raw, 10);
	return Number.isNaN(n) ? null : n;
}
