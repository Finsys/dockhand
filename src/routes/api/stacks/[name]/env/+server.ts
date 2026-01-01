import { json } from '@sveltejs/kit';
import { getStackEnvVars, setStackEnvVars } from '$lib/server/db';
import { getStacksDir } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
			let value = trimmed.substring(eqIndex + 1);
			// Remove surrounding quotes if present
			if ((value.startsWith('"') && value.endsWith('"')) ||
			    (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			result[key] = value;
		}
	}
	return result;
}

/**
 * Merge new variables into existing .env file content.
 * - Keeps comments and formatting
 * - Updates values for existing keys
 * - REMOVES keys that are not in newVars (user deleted them)
 * - Appends new keys at the end
 */
function mergeEnvFileContent(
	existingContent: string,
	newVars: { key: string; value: string }[]
): string {
	const newVarsMap = new Map(newVars.map(v => [v.key, v.value]));
	const handledKeys = new Set<string>();
	const lines = existingContent.split('\n');
	const resultLines: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();

		// Keep comments and blank lines as-is
		if (!trimmed || trimmed.startsWith('#')) {
			resultLines.push(line);
			continue;
		}

		// Check if this is a variable line
		const eqIndex = trimmed.indexOf('=');
		if (eqIndex > 0) {
			const key = trimmed.substring(0, eqIndex).trim();

			if (newVarsMap.has(key)) {
				// Update existing variable with new value from UI
				resultLines.push(`${key}=${newVarsMap.get(key)}`);
				handledKeys.add(key);
			}
			// If key not in newVarsMap, it was deleted - skip it (don't add to resultLines)
		} else {
			// Not a valid variable line, keep as-is
			resultLines.push(line);
		}
	}

	// Append any new variables that weren't in the original file
	for (const v of newVars) {
		if (!handledKeys.has(v.key)) {
			resultLines.push(`${v.key}=${v.value}`);
		}
	}

	// Ensure file ends with newline
	let result = resultLines.join('\n');
	if (!result.endsWith('\n')) {
		result += '\n';
	}
	return result;
}

/**
 * GET /api/stacks/[name]/env?env=X
 * Get all environment variables for a stack.
 * Merges variables from database with .env file (file values shown if different).
 * Secrets are masked with '***' in the response.
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

		// Get variables from database
		const dbVariables = await getStackEnvVars(stackName, envIdNum, true);
		const dbByKey = new Map(dbVariables.map(v => [v.key, v]));

		// Try to read .env file from stack directory
		const stacksDir = getStacksDir();
		const envFilePath = join(stacksDir, stackName, '.env');
		let fileVars: Record<string, string> = {};

		if (existsSync(envFilePath)) {
			try {
				const content = await Bun.file(envFilePath).text();
				fileVars = parseEnvFile(content);
			} catch (e) {
				// Ignore file read errors
			}
		}

		// Merge: start with DB variables, add any new keys from file
		const mergedKeys = new Set([...dbByKey.keys(), ...Object.keys(fileVars)]);
		const variables: { key: string; value: string; isSecret: boolean }[] = [];

		for (const key of mergedKeys) {
			const dbVar = dbByKey.get(key);
			const fileValue = fileVars[key];

			if (dbVar) {
				// Variable exists in DB
				if (dbVar.isSecret) {
					// Keep secret masked
					variables.push({ key, value: dbVar.value, isSecret: true });
				} else if (fileValue !== undefined && fileValue !== dbVar.value) {
					// File has different value - use file value (user may have edited it)
					variables.push({ key, value: fileValue, isSecret: false });
				} else {
					// Use DB value
					variables.push({ key, value: dbVar.value, isSecret: false });
				}
			} else if (fileValue !== undefined) {
				// Variable only in file - add it as non-secret
				variables.push({ key, value: fileValue, isSecret: false });
			}
		}

		return json({ variables });
	} catch (error) {
		console.error('Error getting stack env vars:', error);
		return json({ error: 'Failed to get environment variables' }, { status: 500 });
	}
};

/**
 * PUT /api/stacks/[name]/env?env=X
 * Set/replace all environment variables for a stack.
 * Body: { variables: [{ key, value, isSecret? }] }
 *
 * Note: For secrets, if the value is '***' (the masked placeholder), the original
 * secret value from the database is preserved instead of overwriting with '***'.
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
			// Validate key format (env var naming convention)
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.key)) {
				return json({ error: `Invalid variable name "${v.key}": must start with a letter or underscore and contain only alphanumeric characters and underscores` }, { status: 400 });
			}
		}

		// Check if any secrets have the masked placeholder '***'
		// If so, we need to preserve their original values from the database
		const secretsWithMaskedValue = body.variables.filter(
			(v: { key: string; value: string; isSecret?: boolean }) =>
				v.isSecret && v.value === '***'
		);

		let variablesToSave = body.variables;

		if (secretsWithMaskedValue.length > 0) {
			// Get existing variables (unmasked) to preserve secret values
			const existingVars = await getStackEnvVars(stackName, envIdNum, false);
			const existingByKey = new Map(existingVars.map(v => [v.key, v]));

			// Replace masked secrets with their original values
			variablesToSave = body.variables.map((v: { key: string; value: string; isSecret?: boolean }) => {
				if (v.isSecret && v.value === '***') {
					const existing = existingByKey.get(v.key);
					if (existing && existing.isSecret) {
						// Preserve the original secret value
						return { ...v, value: existing.value };
					}
				}
				return v;
			});
		}

		await setStackEnvVars(stackName, envIdNum, variablesToSave);

		// Also write the .env file to the stack directory
		// This allows users to see/edit variables outside of Dockhand
		const stacksDir = getStacksDir();
		const stackDir = join(stacksDir, stackName);
		const envFilePath = join(stackDir, '.env');

		// Only write if stack directory exists
		if (existsSync(stackDir)) {
			// Read existing file to preserve comments and formatting
			let existingContent = '';
			if (existsSync(envFilePath)) {
				try {
					existingContent = await Bun.file(envFilePath).text();
				} catch {
					// File read failed, start fresh
				}
			}

			// Merge UI vars with existing file (preserves comments, keeps file vars)
			const envContent = mergeEnvFileContent(
				existingContent,
				variablesToSave.map((v: { key: string; value: string }) => ({ key: v.key, value: v.value }))
			);
			await Bun.write(envFilePath, envContent);
		}

		return json({ success: true, count: variablesToSave.length });
	} catch (error) {
		console.error('Error setting stack env vars:', error);
		return json({ error: 'Failed to set environment variables' }, { status: 500 });
	}
};
