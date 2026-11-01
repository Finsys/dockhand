/**
 * Parse .env file content into key-value pairs.
 * Preserves values exactly as written - no quote stripping.
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

/**
 * Extract variable references (placeholders) from an environment value or raw .env line.
 * Matches ${VAR_NAME}, ${VAR_NAME:-default}, ${VAR_NAME-default}, etc., and bare $VAR_NAME.
 * Ignores escaped $$ (Docker Compose escape syntax for literal $).
 */
export function extractEnvPlaceholderReferences(value: string): string[] {
	const trimmed = value.trim();
	if (!trimmed) return [];

	const references = new Set<string>();

	// Match ${VAR_NAME} with optional default/replacement modifiers
	const bracedRegex = /(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)(?:[:\-+?][^}]*)?\}/g;
	let match;
	while ((match = bracedRegex.exec(trimmed)) !== null) {
		references.add(match[1]);
	}

	// Match bare $VAR_NAME (not preceded by alphanumeric char or $, not followed by { or identifier char)
	const simpleRegex = /(?<![A-Za-z0-9\$])\$([A-Za-z_][A-Za-z0-9_]*)(?![{A-Za-z0-9_])/g;
	while ((match = simpleRegex.exec(trimmed)) !== null) {
		references.add(match[1]);
	}

	return [...references];
}
