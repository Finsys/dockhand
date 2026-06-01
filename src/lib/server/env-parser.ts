/**
 * Parse .env file content into key-value pairs.
 * Preserves values exactly as written — no quote stripping.
 * Docker Compose handles its own quote interpretation at runtime.
 */
export function parseEnvVars(content: string): Record<string, string> {
	const result: Record<string, string> = {};

	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;

		const eqIndex = trimmed.indexOf('=');
		if (eqIndex === -1) continue;

		const key = trimmed.substring(0, eqIndex).trim();
		const value = trimmed.substring(eqIndex + 1).trim();

		if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			result[key] = value;
		}
	}

	return result;
}
