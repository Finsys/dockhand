import { json } from '@sveltejs/kit';
import { getStackEnvVars } from '$lib/server/db';
import { getStackComposeFile } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';
import type { RequestHandler } from './$types';

interface ValidationResult {
	valid: boolean;
	required: string[];
	optional: string[];
	defined: string[];
	missing: string[];
	unused: string[];
}

/**
 * Extract environment variables from compose YAML content.
 * Matches ${VAR_NAME} and ${VAR_NAME:-default} patterns.
 * Ignores variables in commented lines (lines starting with #).
 * Ignores escaped $$ (Docker Compose escape syntax for literal $).
 * Returns { required: [...], optional: [...] }
 */
function extractComposeVars(yaml: string): { required: string[]; optional: string[] } {
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
		const simpleRegex = /(?<!\$)\$([A-Za-z_][A-Za-z0-9_]*)(?![{A-Za-z0-9_])/g;
		while ((match = simpleRegex.exec(line)) !== null) {
			const varName = match[1];
			if (!required.includes(varName) && !optional.includes(varName)) {
				required.push(varName);
			}
		}
	}

	return { required: required.sort(), optional: optional.sort() };
}

/**
 * POST /api/stacks/[name]/env/validate?env=X
 * Validate stack environment variables against compose file requirements.
 * Can use saved compose file or accept compose content in body.
 * Body (optional): { compose: "yaml content..." }
 */
export const POST: RequestHandler = async ({ params, url, cookies, request }) => {
	const auth = await authorize(cookies);
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : null;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('stacks', 'view', envIdNum ?? undefined)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !await auth.canAccessEnvironment(envIdNum)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	try {
		const stackName = decodeURIComponent(params.name);
		let composeContent: string | null = null;
		let providedVariables: string[] | null = null;

		// Check if compose content and/or variables are provided in body
		const contentType = request.headers.get('content-type');
		if (contentType?.includes('application/json')) {
			try {
				const body = await request.json();
				if (body.compose && typeof body.compose === 'string') {
					composeContent = body.compose;
				}
				// Accept variables from UI for validation (overrides DB lookup)
				if (Array.isArray(body.variables)) {
					providedVariables = body.variables.filter((v: unknown) => typeof v === 'string');
				}
			} catch {
				// Ignore JSON parse errors - will try to load from file
			}
		}

		// If no compose in body, try to load from saved file
		if (!composeContent) {
			const savedCompose = await getStackComposeFile(stackName);
			if (savedCompose.success && savedCompose.content) {
				composeContent = savedCompose.content;
			}
		}

		if (!composeContent) {
			return json({ error: 'No compose content provided and no saved compose file found' }, { status: 400 });
		}

		// Extract variables from compose
		const { required, optional } = extractComposeVars(composeContent);

		// Get defined variables - either from request body or database
		let defined: string[];
		if (providedVariables !== null) {
			// Use provided variables from UI
			defined = providedVariables.sort();
		} else {
			// Fall back to database
			const envVars = await getStackEnvVars(stackName, envIdNum, false);
			defined = envVars.map(v => v.key).sort();
		}

		// Calculate missing and unused
		const missing = required.filter(v => !defined.includes(v));
		const unused = defined.filter(v => !required.includes(v) && !optional.includes(v));

		const result: ValidationResult = {
			valid: missing.length === 0,
			required,
			optional,
			defined,
			missing,
			unused
		};

		return json(result);
	} catch (error) {
		console.error('Error validating stack env vars:', error);
		return json({ error: 'Failed to validate environment variables' }, { status: 500 });
	}
};
