/**
 * Build the config payload the secret-provider edit form POSTs from its field values.
 *
 * - A filled field is sent as-is.
 * - A blank SECRET field is omitted (blank = keep the stored secret).
 * - A blank NON-SECRET field that WAS in the loaded config is sent as an explicit '' so
 *   the server can tell "user cleared it" from "unchanged/absent". Clearing a non-secret
 *   partner (e.g. Infisical clientId) is what drops its orphaned paired secret
 *   (clientSecret) server-side; without the explicit '', the stale secret is merged back
 *   and validation wedges on "Client ID is required when a client secret is set" (#1448).
 */
export function collectProviderFormConfig(
	fieldDefs: Array<{ key: string; isSecret: boolean }>,
	formValues: Record<string, string>,
	loadedKeys: ReadonlySet<string>
): Record<string, string> {
	const config: Record<string, string> = {};
	for (const field of fieldDefs) {
		const value = (formValues[field.key] ?? '').trim();
		if (value) {
			config[field.key] = value;
		} else if (!field.isSecret && loadedKeys.has(field.key)) {
			config[field.key] = '';
		}
	}
	return config;
}
