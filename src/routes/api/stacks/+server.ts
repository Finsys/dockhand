import { json } from '@sveltejs/kit';
import { listComposeStacks, deployStack, saveStackComposeFile, writeStackEnvFile, writeRawStackEnvFile, saveStackEnvVarsToDb } from '$lib/server/stacks';
import { EnvironmentNotFoundError } from '$lib/server/docker';
import { upsertStackSource, getStackSources } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { auditStack } from '$lib/server/audit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !(await auth.can('stacks', 'view', envIdNum))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !(await auth.canAccessEnvironment(envIdNum))) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	// Early return if no environment specified
	if (!envIdNum) {
		return json([]);
	}

	try {
		const stacks = await listComposeStacks(envIdNum);

		// Add stacks from database that are internally managed but don't have containers yet
		// (created with "Create" button, not "Create & Start")
		const stackSources = await getStackSources(envIdNum);
		const existingNames = new Set(stacks.map((s) => s.name));

		// Enrich Docker-discovered stacks with source type from DB
		for (const stack of stacks) {
			const source = stackSources.find(s => s.stackName === stack.name);
			if (source) {
				(stack as any).sourceType = source.sourceType;
			}
		}

		for (const source of stackSources) {
			// Add stacks from database that aren't already in the Docker list
			// This includes internal, git, and external (adopted) stacks that are currently down
			if (!existingNames.has(source.stackName)) {
				stacks.push({
					name: source.stackName,
					containers: [],
					containerDetails: [],
					status: 'created' as any,
					sourceType: source.sourceType
				} as any);
			}
		}

		return json(stacks);
	} catch (error) {
		if (error instanceof EnvironmentNotFoundError) {
			return json({ error: 'Environment not found' }, { status: 404 });
		}
		console.error('Error listing compose stacks:', error);
		// Return empty array instead of error to allow UI to load
		return json([]);
	}
};

export const POST: RequestHandler = async (event) => {
	const { request, url, cookies } = event;
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !(await auth.can('stacks', 'create', envIdNum))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !(await auth.canAccessEnvironment(envIdNum))) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	try {
		const body = await request.json();
		const { name, compose, start, envVars, rawEnvContent, composePath, envPath } = body;

		if (!name || typeof name !== 'string') {
			return json({ error: 'Stack name is required' }, { status: 400 });
		}

		if (!compose || typeof compose !== 'string') {
			return json({ error: 'Compose file content is required' }, { status: 400 });
		}

		// If start is false, only create the compose file without deploying
		if (start === false) {
			const result = await saveStackComposeFile(name, compose, true, envIdNum, {
				composePath: composePath || undefined,
				envPath: envPath || undefined
			});
			if (!result.success) {
				return json({ error: result.error }, { status: 400 });
			}

			// Save environment variables
			// - rawEnvContent → .env file (non-secrets with comments)
			// - secrets only → DB (for shell injection at runtime)
			if (rawEnvContent) {
				await writeRawStackEnvFile(name, rawEnvContent, envIdNum, envPath || undefined);
			}
			if (envVars && Array.isArray(envVars) && envVars.length > 0) {
				const secrets = envVars.filter((v: any) => v.isSecret);
				if (secrets.length > 0) {
					await saveStackEnvVarsToDb(name, secrets, envIdNum);
				}
				// Fallback: if no rawEnvContent, generate .env from non-secret vars
				if (!rawEnvContent) {
					await writeStackEnvFile(name, envVars, envIdNum, envPath || undefined);
				}
			}

			// Record the stack as internally created with custom paths if provided
			await upsertStackSource({
				stackName: name,
				environmentId: envIdNum,
				sourceType: 'internal',
				composePath: composePath || undefined,
				envPath: envPath || undefined
			});

			// Audit log
			await auditStack(event, 'create', name, envIdNum);

			return json({ success: true, started: false });
		}

		// ALWAYS save compose file first - deployStack expects it to exist
		await saveStackComposeFile(name, compose, true, envIdNum, {
			composePath: composePath || undefined,
			envPath: envPath || undefined
		});

		// Save environment variables BEFORE deploying so they're available during start
		if (rawEnvContent || (envVars && Array.isArray(envVars) && envVars.length > 0)) {
			if (rawEnvContent) {
				await writeRawStackEnvFile(name, rawEnvContent, envIdNum, envPath || undefined);
			}
			if (envVars && Array.isArray(envVars) && envVars.length > 0) {
				const secrets = envVars.filter((v: any) => v.isSecret);
				if (secrets.length > 0) {
					await saveStackEnvVarsToDb(name, secrets, envIdNum);
				}
				// Fallback: if no rawEnvContent, generate .env from non-secret vars
				if (!rawEnvContent) {
					await writeStackEnvFile(name, envVars, envIdNum, envPath || undefined);
				}
			}
		}

		// Deploy and start the stack
		const result = await deployStack({
			name,
			compose,
			envId: envIdNum,
			composePath: composePath || undefined,
			envPath: envPath || undefined
		});

		if (!result.success) {
			return json({ error: result.error, output: result.output }, { status: 400 });
		}

		// Record the stack as internally created with custom paths if provided
		await upsertStackSource({
			stackName: name,
			environmentId: envIdNum,
			sourceType: 'internal',
			composePath: composePath || undefined,
			envPath: envPath || undefined
		});

		// Audit log (create + deploy in one action)
		await auditStack(event, 'deploy', name, envIdNum);

		return json({ success: true, started: true, output: result.output });
	} catch (error: any) {
		console.error('Error creating compose stack:', error);
		return json({ error: error.message || 'Failed to create stack' }, { status: 500 });
	}
};
