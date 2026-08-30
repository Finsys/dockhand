import { json } from '@sveltejs/kit';
import { listComposeStacks, deployStack, saveStackComposeFile, writeStackEnvFile, writeRawStackEnvFile, saveStackEnvVarsToDb } from '$lib/server/stacks';
import { EnvironmentNotFoundError, DockerConnectionError } from '$lib/server/docker';
import { upsertStackSource, getStackSources } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { auditStack } from '$lib/server/audit';
import { createJobResponse } from '$lib/server/sse';
import { createRunRecorder } from '$lib/server/deploy-run-record';
import { hashComposeContent, hashEnvFingerprint } from '$lib/server/deploy-run-record-core';
import { parseEnvFileContent } from '$lib/server/git';
import type { RequestHandler } from './$types';

/**
 * @openapi
 * summary: List compose stacks for one environment (internal, external, and git)
 * query: env:integer Environment id
 * resp-403: Permission denied (needs stacks:view)
 * resp-404: Environment not found
 */
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

		// Enrich Docker-discovered stacks with source type + icon from DB
		for (const stack of stacks) {
			const source = stackSources.find(s => s.stackName === stack.name);
			if (source) {
				(stack as any).sourceType = source.sourceType;
				(stack as any).icon = source.icon;
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
					sourceType: source.sourceType,
					icon: source.icon
				} as any);
			}
		}

		return json(stacks);
	} catch (error) {
		if (error instanceof EnvironmentNotFoundError) {
			return json({ error: 'Environment not found' }, { status: 404 });
		}
		// Silently return empty for connection errors (offline environments)
		if (error instanceof DockerConnectionError) {
			return json([]);
		}
		console.error('Error listing compose stacks:', error);
		return json([]);
	}
};

/**
 * @openapi
 * summary: Create and (optionally) deploy a compose stack
 * description: Writes the compose + .env to the stack dir, stores secrets in the DB, and with start deploys it. Can bind a secret provider.
 * query: env:integer Target environment id
 * body: {name:string!, compose:string!, composePath:string, envPath:string, envVars:array<object>, rawEnvContent:string, secretProviderId:integer, start:boolean, pull:boolean, build:boolean, forceRecreate:boolean}
 * resp-400: Invalid request (e.g. missing name/compose, or secretProviderId wrong type)
 * resp-403: Permission denied (needs stacks:create; binding a secret provider also needs secrets:view)
 * resp-500: Failed to create or deploy the stack
 */
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
		const { name, compose, start, envVars, rawEnvContent, composePath, envPath, secretProviderId, pull, build, forceRecreate } = body;

		if (!name || typeof name !== 'string') {
			return json({ error: 'Stack name is required' }, { status: 400 });
		}

		if (!compose || typeof compose !== 'string') {
			return json({ error: 'Compose file content is required' }, { status: 400 });
		}

		if (
			'secretProviderId' in body &&
			secretProviderId !== null &&
			typeof secretProviderId !== 'number'
		) {
			return json({ error: 'secretProviderId must be a number or null' }, { status: 400 });
		}

		// Binding a secret provider resolves its secrets into the container at deploy;
		// require the secrets permission so a stacks-only user can't exfiltrate a
		// provider's secrets by binding it and reading the container env.
		if (
			typeof secretProviderId === 'number' &&
			auth.authEnabled &&
			!(await auth.can('secrets', 'view', envIdNum))
		) {
			return json({ error: 'Permission denied: binding a secret provider requires the secrets permission' }, { status: 403 });
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
				envPath: envPath || undefined,
				secretProviderId,
			});

			// Audit log
			await auditStack(event, 'create', name, envIdNum);

			return json({ success: true, started: false });
		}

		// ALWAYS save compose file first - deployStack expects it to exist
		const saveResult = await saveStackComposeFile(name, compose, true, envIdNum, {
			composePath: composePath || undefined,
			envPath: envPath || undefined
		});
		if (!saveResult.success) {
			return json({ error: saveResult.error }, { status: 400 });
		}

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

		// Record the stack in DB before deploying - ensures it exists even if deploy fails
		await upsertStackSource({
			stackName: name,
			environmentId: envIdNum,
			sourceType: 'internal',
			composePath: composePath || undefined,
			envPath: envPath || undefined,
			secretProviderId
		});

		// This endpoint has no requireComposeFile() call to hash the way the
		// dedicated deploy endpoint does -- compose and the effective env are
		// already sitting in the request body. rawEnvContent, when given, is the
		// authoritative non-secret source (see the persistence logic above); the
		// envVars array's secrets always layer on top of it.
		const effectiveEnvVars: Record<string, string> = {};
		if (rawEnvContent) {
			Object.assign(effectiveEnvVars, parseEnvFileContent(rawEnvContent, name));
		}
		if (Array.isArray(envVars)) {
			for (const v of envVars) {
				if (v && typeof v.key === 'string' && typeof v.value === 'string' && (!rawEnvContent || v.isSecret)) {
					effectiveEnvVars[v.key] = v.value;
				}
			}
		}

		// Build/pull/forceRecreate come from the caller (StackModal's "Create & Start"
		// popover, see RedeployPopover) -- previously this endpoint always deployed with
		// build:false and no pullPolicy regardless of what the compose file needed, so a
		// service with a `build:` section silently never built on first start.
		const pullOpt = !!pull;
		const buildOpt = !!build;
		const forceRecreateOpt = !!forceRecreate;

		const recorder = await createRunRecorder({
			stackName: name,
			envId: envIdNum ?? null,
			userId: auth.user?.id,
			triggeredBy: 'manual',
			options: { pull: pullOpt, build: buildOpt, forceRecreate: forceRecreateOpt },
			composeHash: hashComposeContent(compose),
			envHash: hashEnvFingerprint(effectiveEnvVars),
			// Same merged set passed to envHash above -- also the redaction list end()
			// applies to the stored error text, so a leaked env value never reaches
			// errorMessage on schedule_executions.
			secrets: Object.values(effectiveEnvVars)
		});

		// Deploy via SSE to keep connection alive during long operations
		return createJobResponse(async (send) => {
			try {
				const result = await deployStack({
					name,
					compose,
					envId: envIdNum,
					forceRecreate: forceRecreateOpt,
					build: buildOpt,
					// pullPolicy undefined (pull unchecked) also skips deployStack's post-deploy
					// reconcileStackPendingUpdates() call -- accepted tradeoff, not a bug.
					pullPolicy: pullOpt ? 'always' : undefined,
					composePath: composePath || undefined,
					envPath: envPath || undefined,
					onLine: (line) => send('progress', { type: 'line', line })
				});

				if (!result.success) {
					send('result', { success: false, error: result.error, output: result.output });
					return;
				}

				// Audit log (create + deploy in one action)
				await auditStack(event, 'deploy', name, envIdNum, {
					pull: pullOpt, build: buildOpt, forceRecreate: forceRecreateOpt
				});

				send('result', { success: true, started: true, output: result.output });
			} catch (error: any) {
				console.error('Error deploying compose stack:', error);
				send('result', { success: false, error: error.message || 'Failed to deploy stack' });
			}
		}, request, recorder);
	} catch (error: any) {
		console.error('Error creating compose stack:', error);
		return json({ error: error.message || 'Failed to create stack' }, { status: 500 });
	}
};
