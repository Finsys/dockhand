/**
 * Parse compose YAML to extract environment variable interpolation mappings.
 * Returns pairs of [containerEnvKey, interpolationVariable].
 *
 * Handles patterns:
 *   - VAR=${ref}
 *   - VAR=${ref:-default}
 *   - VAR=${ref:+alt}
 *   - VAR=${ref?error}
 *
 * Only extracts from `environment:` sections (list format: `- KEY=value`).
 */
export function parseEnvInterpolation(composeContent: string): Array<[string, string]> {
	const results: Array<[string, string]> = [];

	// Step 1: Find lines matching `- ENV_KEY=...${...}...`
	const linePattern = /^\s*-\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)/gm;
	let lineMatch;
	while ((lineMatch = linePattern.exec(composeContent)) !== null) {
		const containerKey = lineMatch[1];
		const valueStr = lineMatch[2];

		// Step 2: Extract all ${VAR} references from the value
		const varPattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:[:\-\+\?][^}]*)?\}/g;
		let varMatch;
		while ((varMatch = varPattern.exec(valueStr)) !== null) {
			const varName = varMatch[1];
			// Only add if names differ — same-name case handled by direct key matching
			if (containerKey !== varName) {
				results.push([containerKey, varName]);
			}
		}
	}

	return results;
}
