import { json } from '@sveltejs/kit';
import { isValidStackName } from '$lib/server/stack-name-guard';
import { getStackEnvVars } from '$lib/server/db';
import { getStackComposeFile } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';
import { extractEnvPlaceholderReferences } from '$lib/server/env-parser';
import { extractComposeVars } from '$lib/utils/compose-var-ref';
import type { RequestHandler } from './$types';

interface ValidationResult {
	valid: boolean;
	required: string[];
	optional: string[];
	defined: string[];
	missing: string[];
	unused: string[];
}

/** Docker and Compose built-in env vars consumed implicitly at runtime (not via ${} interpolation) */
const DOCKER_COMPOSE_BUILTIN_VARS = new Set([
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
 * POST /api/stacks/[name]/env/validate?env=X
 *
 * @openapi
 * summary: Validate a stack's defined environment variables against the variables required/optional by its compose file (compose content and the defined variable list may be supplied in the body, otherwise loaded from the saved file/DB)
 * path: name:string! Stack name (from GET /api/stacks)
 * query: env:integer Environment ID the stack belongs to (from GET /api/environments)
 * body: {compose:string, variables:array<string>, envValues:object}
 * body-example: {"compose":"services:\n  web:\n    image: ${IMAGE}","variables":["IMAGE"]}
 * resp-200: {valid:boolean!, required:array<string>!, optional:array<string>!, defined:array<string>!, missing:array<string>!, unused:array<string>!}
 * resp-200-example: {"valid":false,"required":["IMAGE"],"optional":[],"defined":[],"missing":["IMAGE"],"unused":[]}
 * resp-400: No compose content provided and no saved compose file found
 * resp-403: Permission denied (requires stacks:view, or environment access denied on enterprise)
 * resp-500: Failed to validate environment variables
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
		// Validate the name shape before it is used in a filesystem path.
		const stackName = params.name;
		if (!isValidStackName(stackName)) {
			return json({ error: 'Invalid stack name' }, { status: 400 });
		}
		let composeContent: string | null = null;
		let providedVariables: string[] | null = null;
		let providedEnvValues: Record<string, string> | null = null;

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
				if (body.envValues && typeof body.envValues === 'object' && !Array.isArray(body.envValues)) {
					providedEnvValues = body.envValues as Record<string, string>;
				}
			} catch {
				// Ignore JSON parse errors - will try to load from file
			}
		}

		// If no compose in body, try to load from saved file
		if (!composeContent) {
			// Pass the env id so an environment-scoped stack_sources row is found - without
			// it getStackSource scopes to environment_id IS NULL and the fallback misses (#1423).
			const savedCompose = await getStackComposeFile(stackName, envIdNum);
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

		// Calculate missing and unused. Built-in Docker/Compose vars are provided implicitly
		// by the runtime, so they're never "missing" even if not in the user's env panel.
		// Variables referenced as placeholders within other env values are also treated as used.
		const placeholderRefs = new Set<string>();
		if (providedEnvValues) {
			for (const val of Object.values(providedEnvValues)) {
				if (typeof val === 'string') {
					for (const ref of extractEnvPlaceholderReferences(val)) {
						placeholderRefs.add(ref);
					}
				}
			}
		}

		const missing = required.filter(v => !defined.includes(v) && !DOCKER_COMPOSE_BUILTIN_VARS.has(v));
		const unused = defined.filter(
			v => !required.includes(v) && !optional.includes(v) && !placeholderRefs.has(v) && !DOCKER_COMPOSE_BUILTIN_VARS.has(v)
		);

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
