import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import {
	createGitRepository,
	createGitStack,
	getGitCredentials,
	getGitRepository,
	getStackEnvVars,
	getStackSource,
	setStackEnvVars,
	upsertStackSource
} from '$lib/server/db';
import { secureRandomBytes } from '$lib/server/crypto-fallback';
import { registerSchedule } from '$lib/server/scheduler';
import { auditGitStack, auditStack } from '$lib/server/audit';
import { createJobResponse } from '$lib/server/sse';
import { deployGitStack } from '$lib/server/git';

const STACK_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export const POST: RequestHandler = async (event) => {
	const { params, request, url, cookies } = event;
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId, 10) : undefined;
	const stackName = decodeURIComponent(params.name);

	try {
		if (auth.authEnabled && !(await auth.can('stacks', 'edit', envIdNum))) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}

		const source = await getStackSource(stackName, envIdNum);
		if (!source) {
			return json({ error: 'Stack not found' }, { status: 404 });
		}

		if (source.sourceType !== 'internal') {
			return json({ error: 'Only local stacks can be converted to Git management' }, { status: 400 });
		}

		const data = await request.json();

		if (data.stackName && data.stackName.trim() !== stackName) {
			return json({ error: 'Stack name cannot be changed during conversion' }, { status: 400 });
		}

		if (!STACK_NAME_REGEX.test(stackName)) {
			return json({ error: 'Invalid stack name' }, { status: 400 });
		}

		let repositoryId = data.repositoryId;

		if (!repositoryId) {
			if (!data.url || typeof data.url !== 'string') {
				return json({ error: 'Repository URL or existing repository ID is required' }, { status: 400 });
			}

			if (data.credentialId) {
				const credentials = await getGitCredentials();
				const credential = credentials.find((c) => c.id === data.credentialId);
				if (!credential) {
					return json({ error: 'Invalid credential ID' }, { status: 400 });
				}
			}

			try {
				const repo = await createGitRepository({
					name: data.repoName || stackName,
					url: data.url,
					branch: data.branch || 'main',
					credentialId: data.credentialId || null
				});
				repositoryId = repo.id;
			} catch (error: any) {
				if (error.message?.includes('UNIQUE constraint failed')) {
					return json({ error: 'A repository with this name already exists' }, { status: 400 });
				}
				throw error;
			}
		} else {
			const repo = await getGitRepository(repositoryId);
			if (!repo) {
				return json({ error: 'Repository not found' }, { status: 400 });
			}
		}

		let webhookSecret = data.webhookSecret;
		if (data.webhookEnabled && !webhookSecret) {
			webhookSecret = secureRandomBytes(32).toString('hex');
		}

		const gitStack = await createGitStack({
			stackName,
			environmentId: envIdNum ?? null,
			repositoryId,
			composePath: data.composePath || 'compose.yaml',
			envFilePath: data.envFilePath || null,
			autoUpdate: data.autoUpdate || false,
			autoUpdateSchedule: data.autoUpdateSchedule || 'daily',
			autoUpdateCron: data.autoUpdateCron || '0 3 * * *',
			webhookEnabled: data.webhookEnabled || false,
			webhookSecret
		});

		await upsertStackSource({
			stackName,
			environmentId: envIdNum ?? null,
			sourceType: 'git',
			gitRepositoryId: repositoryId,
			gitStackId: gitStack.id,
			composePath: source.composePath ?? null,
			envPath: source.envPath ?? null
		});

		if (gitStack.autoUpdate && gitStack.autoUpdateCron) {
			await registerSchedule(gitStack.id, 'git_stack_sync', gitStack.environmentId);
		}

		if (data.envVars && Array.isArray(data.envVars)) {
			const existingVars = await getStackEnvVars(stackName, envIdNum ?? null, false);
			const existingByKey = new Map(existingVars.map((v) => [v.key, v]));

			const varsToSave = data.envVars
				.filter((v: any) => v.key?.trim())
				.map((v: any) => {
					if (v.isSecret && v.value === '***') {
						const existingVar = existingByKey.get(v.key.trim());
						if (existingVar && existingVar.isSecret) {
							return {
								key: v.key.trim(),
								value: existingVar.value,
								isSecret: true
							};
						}
						return null;
					}

					return {
						key: v.key.trim(),
						value: v.value ?? '',
						isSecret: v.isSecret ?? false
					};
				})
				.filter(Boolean);

			await setStackEnvVars(stackName, envIdNum ?? null, varsToSave as any);
		}

		await auditStack(event, 'update', stackName, envIdNum ?? null, {
			action: 'convert_to_git'
		});
		await auditGitStack(event, 'create', gitStack.id, gitStack.stackName, gitStack.environmentId, {
			action: 'convert_from_internal'
		});

		if (data.deployNow) {
			return createJobResponse(async (send) => {
				try {
					const deployResult = await deployGitStack(gitStack.id);
					await auditGitStack(event, 'deploy', gitStack.id, gitStack.stackName, gitStack.environmentId);
					send('result', {
						...gitStack,
						deployResult
					});
				} catch (error) {
					console.error('Failed to deploy git stack:', error);
					send('result', {
						...gitStack,
						deployResult: { success: false, error: 'Failed to deploy git stack' }
					});
				}
			}, request);
		}

		return json(gitStack);
	} catch (error: any) {
		console.error('Failed to convert local stack to git:', error);
		if (error.message?.includes('UNIQUE constraint failed')) {
			if (error.message?.includes('stack_environment_variables')) {
				return json({ error: 'Duplicate environment variable keys detected' }, { status: 400 });
			}
			return json({ error: 'A git stack with this name already exists for this environment' }, { status: 400 });
		}
		return json({ error: 'Failed to convert stack to Git management' }, { status: 500 });
	}
};
