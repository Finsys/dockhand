import { json } from '@sveltejs/kit';
import { getStackEnvVars, setStackEnvVars, getStackSource, getStackInjectedSecretKeys, getSecretProviderById } from '$lib/server/db';
import { findStackDir } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { RequestHandler } from './$types';

/**
 * Parse a .env file content into key-value pairs
 */
function parseEnvFile(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		// Skip empty lines and comments
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eqIndex = trimmed.indexOf('=');
		if (eqIndex > 0) {
			const key = trimmed.substring(0, eqIndex).trim();
			const value = trimmed.substring(eqIndex + 1);
			result[key] = value;
		}
	}
	return result;
}

/**
 * GET /api/stacks/[name]/env?env=X
 * Get all environment variables for a stack.
 * Merges variables from database with .env file (file values override for non-secrets).
 *
 * SECURITY: Secrets are returned as '***' (masked) - they are NEVER sent in plain text.
 * Secrets are stored only in the database and injected via shell environment at runtime.
 * The .env file only contains non-secret variables.
 */
/**
 * @openapi
 * summary: Get a stack's env vars plus injected provider keys
 * description: The source of `variables` depends on the stack type. For a GIT stack, ALL variables (secret and non-secret) come from the database via this endpoint - the DB is the canonical store the UI, `POST /env/validate`, and deploys read. For an INTERNAL/adopted stack, non-secrets come from the on-disk `.env` file (written via `PUT /env/raw`) and only secrets come from the DB. Secret values are masked as `***` and never returned in plaintext. Each variable is `{ key, value, isSecret }`.
 * path: name:string The stack name
 * query: env:integer Environment id the stack belongs to
 * resp-200: {variables:array<{key:string!, value:string!, isSecret:boolean!}>!, injectedSecretKeys:array<string>, secretProvider:object}
 * resp-403: Permission denied (needs stacks:view)
 * resp-500: Failed to read env vars
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
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

		// Get secrets from database (masked - values show as '***')
		const dbSecrets = await getStackEnvVars(stackName, envIdNum, true);

		// Check if this stack has a custom compose path configured
		const source = await getStackSource(stackName, envIdNum);

		// Determine the env file path based on path resolution rules:
		// - envPath = '' (empty string) → explicitly no env file
		// - envPath = '/path/.env' → use custom path
		// - envPath = null with composePath → .env next to compose
		// - envPath = null without composePath → use default location
		let envFilePath: string | null = null;

		if (source?.envPath === '') {
			envFilePath = null;
		} else if (source?.envPath) {
			envFilePath = source.envPath;
		} else if (source?.composePath) {
			envFilePath = join(dirname(source.composePath), '.env');
		} else {
			const stackDir = await findStackDir(stackName, envIdNum);
			if (stackDir) {
				envFilePath = join(stackDir, '.env');
			}
		}

		const variables: { key: string; value: string; isSecret: boolean }[] = [];

		if (source?.sourceType === 'git') {
			// Git stacks: ALL vars (overrides + secrets) come from DB
			for (const dbVar of dbSecrets) {
				variables.push({ key: dbVar.key, value: dbVar.value, isSecret: dbVar.isSecret });
			}
		} else {
			// Internal/adopted stacks: non-secrets from file, secrets from DB
			if (envFilePath && existsSync(envFilePath)) {
				try {
					const content = readFileSync(envFilePath, 'utf-8');
					const fileVars = parseEnvFile(content);
					for (const [key, value] of Object.entries(fileVars)) {
						variables.push({ key, value, isSecret: false });
					}
				} catch {
					// Ignore file read errors
				}
			}

			// Secrets come from the database (never written to file)
			for (const secret of dbSecrets) {
				if (secret.isSecret) {
					variables.push({ key: secret.key, value: secret.value, isSecret: true });
				}
			}
		}

		// Provider-injected key NAMES from the last deploy (no values) + the bound
		// provider's type/name, so the UI can show "these were loaded from <provider>".
		const injectedSecretKeys = [...await getStackInjectedSecretKeys(stackName, envIdNum ?? undefined)];
		let secretProvider: { type: string; name: string } | null = null;
		if (source?.secretProviderId) {
			const p = await getSecretProviderById(source.secretProviderId);
			if (p) secretProvider = { type: p.type, name: p.name };
		}

		return json({ variables, injectedSecretKeys, secretProvider });
	} catch (error) {
		console.error('Error getting stack env vars:', error);
		return json({ error: 'Failed to get environment variables' }, { status: 500 });
	}
};

/**
 * PUT /api/stacks/[name]/env?env=X
 * Save environment variables for a stack. Body: { variables: [{ key, value, isSecret }] }.
 *
 * Every variable in the body is written to the database. For a git stack the DB is the
 * canonical store for both overrides and secrets; for an internal/adopted stack the DB
 * holds secrets while non-secrets normally live in the .env file (written by PUT /env/raw).
 *
 * If a secret's value is '***' (masked placeholder), the original value from the database
 * is preserved.
 */
/**
 * @openapi
 * summary: Save a stack's env vars to the DB
 * description: Persists EVERY variable in the body to the database (secrets and non-secrets alike). For a GIT stack this is the canonical store - non-secret overrides and secrets both belong here, NOT in the `.env` file. For an INTERNAL/adopted stack the DB is used for secrets while non-secrets are expected in the `.env` file (written via `PUT /env/raw`); posting a non-secret here still saves it but the file remains the source the UI reads for that type. A masked secret value of `***` is left unchanged (the stored value is preserved). Each item is `{ key, value, isSecret? }`; a request whose `variables` are not such objects is rejected with 400.
 * path: name:string The stack name
 * query: env:integer Environment id the stack belongs to
 * body: {variables:array<{key:string!, value:string!, isSecret:boolean}>!}
 * body-example: {"variables":[{"key":"DB_HOST","value":"db","isSecret":false},{"key":"DB_PASSWORD","value":"s3cret","isSecret":true}]}
 * resp-400: Invalid variables payload
 * resp-403: Permission denied (needs stacks:edit)
 * resp-500: Failed to save env vars
 */
export const PUT: RequestHandler = async ({ params, url, cookies, request }) => {
	const auth = await authorize(cookies);
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : null;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('stacks', 'edit', envIdNum ?? undefined)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !await auth.canAccessEnvironment(envIdNum)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	try {
		const stackName = decodeURIComponent(params.name);
		const body = await request.json();

		if (!body.variables || !Array.isArray(body.variables)) {
			return json({ error: 'Invalid request body: variables array required' }, { status: 400 });
		}

		// Validate variables
		for (const v of body.variables) {
			if (!v.key || typeof v.key !== 'string') {
				return json({ error: 'Invalid variable: key is required and must be a string' }, { status: 400 });
			}
			if (typeof v.value !== 'string') {
				return json({ error: `Invalid variable "${v.key}": value must be a string` }, { status: 400 });
			}
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.key)) {
				return json({ error: `Invalid variable name "${v.key}": must start with a letter or underscore and contain only alphanumeric characters and underscores` }, { status: 400 });
			}
		}

		// Preserve masked secret values ('***') from the database
		const secretsWithMaskedValue = body.variables.filter(
			(v: { key: string; value: string; isSecret?: boolean }) =>
				v.isSecret && v.value === '***'
		);

		let variablesToSave = body.variables;

		if (secretsWithMaskedValue.length > 0) {
			const existingVars = await getStackEnvVars(stackName, envIdNum, false);
			const existingByKey = new Map(existingVars.map(v => [v.key, v]));

			variablesToSave = body.variables.map((v: { key: string; value: string; isSecret?: boolean }) => {
				if (v.isSecret && v.value === '***') {
					const existing = existingByKey.get(v.key);
					if (existing && existing.isSecret) {
						return { ...v, value: existing.value };
					}
				}
				return v;
			});
		}

		// Save secrets to database (non-secrets live in the .env file)
		await setStackEnvVars(stackName, envIdNum, variablesToSave);

		return json({ success: true, count: variablesToSave.length });
	} catch (error) {
		console.error('Error setting stack env vars:', error);
		return json({ error: 'Failed to set environment variables' }, { status: 500 });
	}
};
