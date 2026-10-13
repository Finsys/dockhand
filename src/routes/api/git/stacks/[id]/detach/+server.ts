import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import {
	getGitStack,
	deleteGitStack,
	upsertStackSource,
	getStackEnvVars
} from '$lib/server/db';
import { deleteGitStackFiles } from '$lib/server/git';
import { unregisterSchedule } from '$lib/server/scheduler';
import { auditGitStack } from '$lib/server/audit';
import { getStackComposeFile, getStackDir, writeStackEnvFile } from '$lib/server/stacks';
import { parseEnvVars } from '$lib/server/env-parser';
import { mergeGitStackEnvVars } from '$lib/env-merge';
import { repoFilePath } from '$lib/server/git-url-safety';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * @openapi
 * summary: Convert a git-managed stack to a local stack
 * path: id:integer! Git stack ID (from GET /api/git/stacks)
 * resp-200: {success:boolean!}
 * resp-200-example: {"success":true}
 * resp-400: Invalid git stack ID
 * resp-403: Caller lacks the stacks:edit permission for the stack environment
 * resp-404: Git stack not found
 * resp-409: No deployed compose file is available; deploy the Git stack before conversion
 * resp-500: Failed to convert the stack to a local source
 */
export const POST: RequestHandler = async (event) => {
	const { params, cookies } = event;
	const auth = await authorize(cookies);

	try {
		const id = parseInt(params.id, 10);
		if (Number.isNaN(id)) {
			return json({ error: 'Invalid git stack id' }, { status: 400 });
		}

		const gitStack = await getGitStack(id);
		if (!gitStack) {
			return json({ error: 'Git stack not found' }, { status: 404 });
		}

		if (
			auth.authEnabled &&
			!(await auth.can('stacks', 'edit', gitStack.environmentId || undefined))
		) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}

		const composeResult = await getStackComposeFile(
			gitStack.stackName,
			gitStack.environmentId ?? null
		);

		if (!composeResult.success || !composeResult.composePath) {
			return json({ error: 'No deployed compose file is available. Deploy the Git stack successfully before converting it to a local source.' }, { status: 409 });
		}

		const envVars = await getStackEnvVars(gitStack.stackName, gitStack.environmentId ?? null, false);

		// Internal stacks use the on-disk env file as their non-secret source of truth.
		// Materialize the last-deployed repo env plus DB overrides before switching.
		const targetEnvPath = join(dirname(composeResult.composePath), '.env');
		const baseExists = existsSync(targetEnvPath);
		const baseVars = baseExists
			? parseEnvVars(readFileSync(targetEnvPath, 'utf-8'))
			: {};
		let overlayExists = false;
		let overlayVars: Record<string, string> = {};

		if (gitStack.envFilePath) {
			const repoRoot = resolve('/repo');
			const repoComposePath = repoFilePath(repoRoot, gitStack.composePath, 'Compose path');
			const repoEnvPath = repoFilePath(repoRoot, gitStack.envFilePath, 'Env file path');
			const deployedEnvPath = resolve(
				dirname(composeResult.composePath),
				relative(dirname(repoComposePath), repoEnvPath)
			);
			const deployedStackDir = resolve(await getStackDir(gitStack.stackName, gitStack.environmentId));
			const isInsideDeployedStack =
				deployedEnvPath === deployedStackDir || deployedEnvPath.startsWith(deployedStackDir + sep);
			if (
				isInsideDeployedStack &&
				deployedEnvPath !== targetEnvPath &&
				existsSync(deployedEnvPath)
			) {
				overlayExists = true;
				overlayVars = parseEnvVars(readFileSync(deployedEnvPath, 'utf-8'));
			}
		}

		const effectiveVars = mergeGitStackEnvVars({ ...baseVars, ...overlayVars }, envVars);
		const nonSecretVars = effectiveVars.filter((variable) => !variable.isSecret);
		const shouldWriteEnv = baseExists || overlayExists || nonSecretVars.length > 0;

		if (shouldWriteEnv) {
			await writeStackEnvFile(
				gitStack.stackName,
				nonSecretVars,
				gitStack.environmentId ?? null,
				targetEnvPath
			);
		}

		await upsertStackSource({
			stackName: gitStack.stackName,
			environmentId: gitStack.environmentId ?? null,
			sourceType: 'internal',
			gitRepositoryId: null,
			gitStackId: null,
			composePath: composeResult.composePath,
			envPath: shouldWriteEnv ? targetEnvPath : null
		});

		unregisterSchedule(id, 'git_stack_sync');
		await deleteGitStack(id);
		await deleteGitStackFiles(id, gitStack.stackName, gitStack.environmentId);

		await auditGitStack(event, 'update', gitStack.id, gitStack.stackName, gitStack.environmentId, {
			action: 'convert_to_internal'
		});

		return json({ success: true });
	} catch (error) {
		console.error('Failed to detach git stack:', error);
		return json({ error: 'Failed to convert stack to local source' }, { status: 500 });
	}
};
