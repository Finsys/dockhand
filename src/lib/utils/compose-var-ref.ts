/**
 * Regex sources for the `$` that starts a compose variable reference. `$$` is compose's escape
 * for one literal dollar, so a reference may follow whole `$$` pairs: `$$${X}` is a literal `$`
 * then `${X}`, while `$${X}` is the text `${X}`.
 */
export const REF_START = '(?<!\\$)(?:\\$\\$)*\\$';

/** The same for a bare `$NAME`, which also must not follow a letter or digit. */
export const BARE_REF_START = '(?<![A-Za-z0-9$])(?:\\$\\$)*\\$';

/**
 * Extract environment variables from compose YAML content.
 * `${VAR}`, `${VAR:?err}` / `${VAR?err}` and a bare `$VAR` are required; `${VAR:-default}`,
 * `${VAR-default}`, `${VAR:+alt}` and `${VAR+alt}` are optional (compose substitutes without them).
 * Ignores variables in commented lines (lines starting with #).
 * Ignores escaped $$ (Docker Compose escape syntax for literal $).
 * Returns { required: [...], optional: [...] }
 */
export function extractComposeVars(yaml: string): { required: string[]; optional: string[] } {
	const required: string[] = [];
	const optional: string[] = [];

	// Process line by line to skip commented lines
	const lines = yaml.split('\n');
	for (const line of lines) {
		// Skip lines that are comments (start with # after optional whitespace)
		const trimmedLine = line.trim();
		if (trimmedLine.startsWith('#')) {
			continue;
		}

		// REF_START skips an escaped `$${` but not a reference after whole `$$` pairs
		const regex = new RegExp(`${REF_START}\\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])[^}]*)?\\}`, 'g');
		let match;

		while ((match = regex.exec(line)) !== null) {
			const varName = match[1];
			const hasDefault = match[2] !== undefined && !match[2].endsWith('?');

			if (hasDefault) {
				if (!optional.includes(varName) && !required.includes(varName)) {
					optional.push(varName);
				}
			} else {
				// Move from optional to required if we find a non-default usage
				const optIdx = optional.indexOf(varName);
				if (optIdx !== -1) {
					optional.splice(optIdx, 1);
				}
				if (!required.includes(varName)) {
					required.push(varName);
				}
			}
		}

		// Also match $VAR_NAME (simple variable substitution)
		// BARE_REF_START also requires no letter or digit before it (avoids values like "1$abc")
		const simpleRegex = new RegExp(`${BARE_REF_START}([A-Za-z_][A-Za-z0-9_]*)(?![{A-Za-z0-9_])`, 'g');
		while ((match = simpleRegex.exec(line)) !== null) {
			const varName = match[1];
			const optIdx = optional.indexOf(varName);
			if (optIdx !== -1) optional.splice(optIdx, 1);
			if (!required.includes(varName)) required.push(varName);
		}
	}

	return { required: required.sort(), optional: optional.sort() };
}
