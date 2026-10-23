import { json } from '@sveltejs/kit';
import { isValidStackName } from '$lib/server/stack-name-guard';
import { getStackComposeFile, loadStackVariables } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';
import { validateStackEnvVars, type EnvValidationResult } from '$lib/server/env-parser';
import type { RequestHandler } from './$types';

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

		// Check if compose content, variables and/or env values are provided in body
		const contentType = request.headers.get('content-type');
		let providedEnvValues: Record<string, string> | null = null;
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

		// Get defined variables and values - either from request body or loaded stack env
		let defined: string[];
		let envValuesForValidation: Record<string, string> | string[] = [];

		if (providedVariables !== null) {
			// Use provided variables from UI
			defined = providedVariables.sort();
			if (providedEnvValues) {
				envValuesForValidation = providedEnvValues;
			}
		} else {
			// Fall back to loading stack variables from DB + .env file
			const loaded = await loadStackVariables(stackName, envIdNum);
			if (loaded.error) {
				return json({ error: loaded.error }, { status: loaded.status || 500 });
			}
			defined = loaded.variables.map(v => v.key).sort();
			envValuesForValidation = loaded.variables.map(v => v.value);
		}

		const result = validateStackEnvVars(composeContent, defined, envValuesForValidation);

		return json(result);
	} catch (error) {
		console.error('Error validating stack env vars:', error);
		return json({ error: 'Failed to validate environment variables' }, { status: 500 });
	}
};
