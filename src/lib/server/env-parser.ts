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

/**
 * Extract variable references (placeholders) from an environment value or raw .env line.
 * Matches ${VAR_NAME}, ${VAR_NAME:-default}, ${VAR_NAME-default}, etc., and bare $VAR_NAME.
 * Ignores escaped $$ and single-quoted literal text in .env syntax.
 */
export function extractEnvPlaceholderReferences(value: string): string[] {
	const trimmed = value.trim();
	if (!trimmed) return [];
	// In .env files, single-quoted values are literal — no escapes or substitutions occur.
	if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
		return [];
	}

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

/** Docker and Compose built-in env vars consumed implicitly at runtime (not via ${} interpolation) */
export const DOCKER_COMPOSE_BUILTIN_VARS = new Set([
	// Docker Compose
	'COMPOSE_PROJECT_NAME', 'COMPOSE_FILE', 'COMPOSE_PROFILES',
	'COMPOSE_CONVERT_WINDOWS_PATHS', 'COMPOSE_PATH_SEPARATOR',
	'COMPOSE_IGNORE_ORPHANS', 'COMPOSE_REMOVE_ORPHANS',
	'COMPOSE_PARALLEL_LIMIT', 'COMPOSE_ANSI', 'COMPOSE_STATUS_STDOUT',
	'COMPOSE_ENV_FILES', 'COMPOSE_DISABLE_ENV_FILE', 'COMPOSE_MENU',
	'COMPOSE_EXPERIMENTAL', 'COMPOSE_PROGRESS',
	// Docker CLI
	'DOCKER_API_VERSION', 'DOCKER_CERT_PATH', 'DOCKER_CONFIG',
	'DOCKER_CONTEXT', 'DOCKER_CUSTOM_HEADERS', 'DOCKER_DEFAULT_PLATFORM',
	'DOCKER_HIDE_LEGACY_COMMANDS', 'DOCKER_HOST', 'DOCKER_TLS',
	'DOCKER_TLS_VERIFY', 'BUILDKIT_PROGRESS', 'NO_COLOR',
]);

/**
 * Extract environment variables from compose YAML content.
 * Matches ${VAR_NAME} and ${VAR_NAME:-default} patterns.
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

		// Match ${VAR_NAME} (required) and ${VAR_NAME:-default} or ${VAR_NAME-default} (optional)
		// Use negative lookbehind (?<!\$) to skip escaped $$ (Docker Compose escape syntax)
		const regex = /(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:-?)[^}]*)?\}/g;
		let match;

		while ((match = regex.exec(line)) !== null) {
			const varName = match[1];
			const hasDefault = match[2] !== undefined;

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
		// Use negative lookbehind (?<!\$) to skip escaped $$
		// Also require $ to not be preceded by an alphanumeric char (avoids matching inside values like "1$abc")
		const simpleRegex = /(?<![A-Za-z0-9\$])\$([A-Za-z_][A-Za-z0-9_]*)(?![{A-Za-z0-9_])/g;
		while ((match = simpleRegex.exec(line)) !== null) {
			const varName = match[1];
			if (!required.includes(varName) && !optional.includes(varName)) {
				required.push(varName);
			}
		}
	}

	return { required: required.sort(), optional: optional.sort() };
}

export interface EnvValidationResult {
	valid: boolean;
	required: string[];
	optional: string[];
	defined: string[];
	missing: string[];
	unused: string[];
}

/**
 * Validates defined environment variables against compose requirements and placeholder references.
 * Variables referenced as placeholders within env values (${VAR} or $VAR) are marked as used.
 */
export function validateStackEnvVars(
	composeContent: string,
	definedVars: string[],
	envValues: Array<string | undefined> | Record<string, string> = []
): EnvValidationResult {
	const { required, optional } = extractComposeVars(composeContent);
	const defined = [...definedVars].sort();

	const valuesList: string[] = Array.isArray(envValues)
		? envValues.filter((v): v is string => typeof v === 'string')
		: Object.values(envValues).filter((v): v is string => typeof v === 'string');

	const placeholderRefs = new Set<string>();
	for (const val of valuesList) {
		for (const ref of extractEnvPlaceholderReferences(val)) {
			placeholderRefs.add(ref);
		}
	}

	const missing = required.filter((v) => !defined.includes(v) && !DOCKER_COMPOSE_BUILTIN_VARS.has(v));
	const unused = defined.filter(
		(v) =>
			!required.includes(v) &&
			!optional.includes(v) &&
			!placeholderRefs.has(v) &&
			!DOCKER_COMPOSE_BUILTIN_VARS.has(v)
	);

	return {
		valid: missing.length === 0,
		required,
		optional,
		defined,
		missing,
		unused
	};
}
