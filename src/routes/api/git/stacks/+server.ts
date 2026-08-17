import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getGitStacks,
	createGitStack,
	getGitCredentials,
	getGitRepository,
	createGitRepository,
	upsertStackSource,
	setStackEnvVars,
	getStackSource
} from '$lib/server/db';
import { deployGitStack } from '$lib/server/git';
import { authorize } from '$lib/server/authorize';
import { registerSchedule } from '$lib/server/scheduler';
import { auditGitStack } from '$lib/server/audit';
import { createJobResponse } from '$lib/server/sse';

// Stack name validation: Docker Compose requires lowercase; must start with a
// letter or number, and contain only lowercase letters, numbers, hyphens, underscores
const STACK_NAME_REGEX = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * @openapi
 * summary: List git-deployed stacks (optionally scoped to one environment)
 * query: env:integer Filter to a single environment id
 * resp-403: Permission denied (needs stacks:view)
 * resp-500: Failed to list git stacks
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('stacks', 'view', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {

		const stacks = await getGitStacks(envIdNum);
		return json(stacks);
	} catch (error) {
		console.error('Failed to get git stacks:', error);
		return json({ error: 'Failed to get git stacks' }, { status: 500 });
	}
};

/**
 * @openapi
 * summary: Create a git-deployed stack (from an existing repo or new repo url/branch)
 * body: {stackName:string!, environmentId:integer, repositoryId:integer, secretProviderId:integer, webhookEnabled:boolean, webhookSecret:string}
 * resp-400: Invalid stack name, or secretProviderId is not a number/null
 * resp-403: Permission denied (needs stacks:create; binding a secret provider also needs secrets:view)
 * resp-409: A git stack with this name already exists in the environment
 * resp-500: Failed to create the git stack
 */
export const POST: RequestHandler = async (event) => {
	const { request, cookies } = event;
	const auth = await authorize(cookies);

	try {
		const data = await request.json();

		// Permission check with environment context
		if (auth.authEnabled && !await auth.can('stacks', 'create', data.environmentId || undefined)) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}

		if (!data.stackName || typeof data.stackName !== 'string') {
			return json({ error: 'Stack name is required' }, { status: 400 });
		}

		const trimmedStackName = data.stackName.trim();
		if (!STACK_NAME_REGEX.test(trimmedStackName)) {
			return json({ error: 'Stack name must be lowercase, start with a letter or number, and contain only letters, numbers, hyphens, and underscores' }, { status: 400 });
		}

		if (
			'secretProviderId' in data &&
			data.secretProviderId !== null &&
			typeof data.secretProviderId !== 'number'
		) {
			return json({ error: 'secretProviderId must be a number or null' }, { status: 400 });
		}

		// Binding a secret provider resolves its secrets into the container at deploy;
		// require the secrets permission so a stacks-only user can't exfiltrate a
		// provider's secrets by binding it and reading the container env.
		if (
			typeof data.secretProviderId === 'number' &&
			auth.authEnabled &&
			!(await auth.can('secrets', 'view', data.environmentId || undefined))
		) {
			return json({ error: 'Permission denied: binding a secret provider requires the secrets permission' }, { status: 403 });
		}

		// Check for name conflicts with existing stacks (regular/external/git)
		const existing = await getStackSource(trimmedStackName, data.environmentId || null);
		if (existing) {
			return json({ error: 'A stack with this name already exists on this environment' }, { status: 409 });
		}

		// A secret is mandatory when the webhook is enabled.
		if (data.webhookEnabled && !data.webhookSecret?.trim()) {
			return json({ error: 'A webhook secret is required when the webhook is enabled' }, { status: 400 });
		}

		// Either repositoryId or new repo details (url, branch) must be provided
		let repositoryId = data.repositoryId;

		if (!repositoryId) {
			// Create a new repository if URL is provided
			if (!data.url || typeof data.url !== 'string') {
				return json({ error: 'Repository URL or existing repository ID is required' }, { status: 400 });
			}

			// Validate credential if provided
			if (data.credentialId) {
				const credentials = await getGitCredentials();
				const credential = credentials.find(c => c.id === data.credentialId);
				if (!credential) {
					return json({ error: 'Invalid credential ID' }, { status: 400 });
				}
			}

			// Create the repository first
			const repoName = data.repoName || data.stackName;
			try {
				const repo = await createGitRepository({
					name: repoName,
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
			// Verify repository exists
			const repo = await getGitRepository(repositoryId);
			if (!repo) {
				return json({ error: 'Repository not found' }, { status: 400 });
			}
		}

		const gitStack = await createGitStack({
			stackName: trimmedStackName,
			environmentId: data.environmentId || null,
			repositoryId: repositoryId,
			// Per-stack branch override — only when targeting an existing repository.
			// In new-repo mode data.branch becomes the repository's default instead;
			// the stack inherits it (branch stays null).
			...(data.repositoryId && typeof data.branch === 'string' && data.branch.trim()
				? { branch: data.branch.trim() }
				: {}),
			composePath: data.composePath || 'compose.yaml',
			envFilePath: data.envFilePath || null,
			autoUpdate: data.autoUpdate || false,
			autoUpdateSchedule: data.autoUpdateSchedule || 'daily',
			autoUpdateCron: data.autoUpdateCron || '0 3 * * *',
			webhookEnabled: data.webhookEnabled || false,
			webhookSecret: data.webhookSecret || null,
			contextDir: data.contextDir || null,
			buildOnDeploy: data.buildOnDeploy ?? false,
			noBuildCache: data.noBuildCache ?? false,
			repullImages: data.repullImages ?? false,
			forceRedeploy: data.forceRedeploy ?? false
		});

		// Create stack_sources entry so the stack appears in the list immediately
		await upsertStackSource({
			stackName: trimmedStackName,
			environmentId: data.environmentId || null,
			sourceType: 'git',
			gitRepositoryId: repositoryId,
			gitStackId: gitStack.id,
			secretProviderId: data.secretProviderId ?? null
		});

		// Register schedule with croner if auto-update is enabled
		if (gitStack.autoUpdate && gitStack.autoUpdateCron) {
			await registerSchedule(gitStack.id, 'git_stack_sync', gitStack.environmentId);
		}

		// Audit log
		await auditGitStack(event, 'create', gitStack.id, gitStack.stackName, gitStack.environmentId);

		// Save environment variable overrides before deploying
		if (data.envVars && Array.isArray(data.envVars) && data.envVars.length > 0) {
			// Filter out masked secrets - on initial creation there are no existing secrets
			// If a secret has value '***', it means something went wrong in the UI
			const varsToSave = data.envVars
				.filter((v: any) => v.key?.trim())
				.filter((v: any) => !(v.isSecret && v.value === '***'))
				.map((v: any) => ({
					key: v.key.trim(),
					value: v.value ?? '',
					isSecret: v.isSecret ?? false
				}));

			if (varsToSave.length > 0) {
				await setStackEnvVars(trimmedStackName, data.environmentId || null, varsToSave);
			}
		}

		// If deployNow is set, deploy immediately via SSE to keep connection alive
		if (data.deployNow) {
			return createJobResponse(async (send) => {
				try {
					const deployResult = await deployGitStack(gitStack.id);
					await auditGitStack(event, 'deploy', gitStack.id, gitStack.stackName, gitStack.environmentId);
					send('result', {
						...gitStack,
						deployResult: deployResult
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
		console.error('Failed to create git stack:', error);
		if (error.message?.includes('UNIQUE constraint failed')) {
			if (error.message?.includes('stack_environment_variables')) {
				return json({ error: 'Duplicate environment variable keys detected' }, { status: 400 });
			}
			return json({ error: 'A git stack with this name already exists for this environment' }, { status: 400 });
		}
		return json({ error: 'Failed to create git stack' }, { status: 500 });
	}
};
