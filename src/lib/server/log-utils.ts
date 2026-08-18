/**
 * Redact all env var values for safe logging. Only key names are preserved.
 */
export function redactEnvVarsForLog(vars: Record<string, string>): Record<string, string> {
	const redacted: Record<string, string> = {};
	for (const key of Object.keys(vars)) {
		redacted[key] = '***';
	}
	return redacted;
}
