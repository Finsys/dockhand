import { json } from '@sveltejs/kit';
import { listComposeStacks, deployStack, saveStackComposeFile, saveStackEnvVars } from '$lib/server/stacks';
import { EnvironmentNotFoundError } from '$lib/server/docker';
import { upsertStackSource, getStackSources } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
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

		for (const source of stackSources) {
			// Only add internal/git stacks that aren't already in the list
			if (
				!existingNames.has(source.stackName) &&
				(source.sourceType === 'internal' || source.sourceType === 'git')
			) {
				stacks.push({
					name: source.stackName,
					containers: [],
					containerDetails: [],
					status: 'created' as any
				});
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

export const POST: RequestHandler = async ({ request, url, cookies }) => {
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
		const { name, compose, start, envVars } = body;

		if (!name || typeof name !== 'string') {
			return json({ error: 'Stack name is required' }, { status: 400 });
		}

		if (!compose || typeof compose !== 'string') {
			return json({ error: 'Compose file content is required' }, { status: 400 });
		}

		// If start is false, only create the compose file without deploying
		if (start === false) {
			const result = await saveStackComposeFile(name, compose, true);
			if (!result.success) {
				return json({ error: result.error }, { status: 400 });
			}

			// Save environment variables if provided (to both DB and .env file)
			if (envVars && Array.isArray(envVars) && envVars.length > 0) {
				await saveStackEnvVars(name, envVars, envIdNum);
			}

			// Record the stack as internally created
			await upsertStackSource({
				stackName: name,
				environmentId: envIdNum,
				sourceType: 'internal'
			});

			return json({ success: true, started: false });
		}

		// Save environment variables BEFORE deploying so they're available during start
		if (envVars && Array.isArray(envVars) && envVars.length > 0) {
			// First ensure the stack directory exists by saving compose file
			await saveStackComposeFile(name, compose, true);
			// Save to both DB and .env file
			await saveStackEnvVars(name, envVars, envIdNum);
		}

		// Deploy and start the stack
		const result = await deployStack({
			name,
			compose,
			envId: envIdNum
		});

		if (!result.success) {
			return json({ error: result.error, output: result.output }, { status: 400 });
		}

		// Record the stack as internally created
		await upsertStackSource({
			stackName: name,
			environmentId: envIdNum,
			sourceType: 'internal'
		});

		return json({ success: true, started: true, output: result.output });
	} catch (error: any) {
		console.error('Error creating compose stack:', error);
		return json({ error: error.message || 'Failed to create stack' }, { status: 500 });
	}
};
