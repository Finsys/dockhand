import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import {
	getGitStack,
	deleteGitStack,
	upsertStackSource,
	getStackSource,
	getStackEnvVars
} from '$lib/server/db';
import { deleteGitStackFiles } from '$lib/server/git';
import { unregisterSchedule } from '$lib/server/scheduler';
import { auditGitStack } from '$lib/server/audit';
import { getStackComposeFile, writeStackEnvFile } from '$lib/server/stacks';

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

		const source = await getStackSource(gitStack.stackName, gitStack.environmentId ?? null);
		const composeResult = await getStackComposeFile(
			gitStack.stackName,
			gitStack.environmentId ?? null
		);

		if (!composeResult.success || !composeResult.composePath) {
			return json({ error: 'No deployed compose file is available. Deploy the Git stack successfully before converting it to a local source.' }, { status: 409 });
		}

		const envVars = await getStackEnvVars(gitStack.stackName, gitStack.environmentId ?? null, false);

		// Internal stacks read non-secret vars from the env file on disk, not from DB.
		// Materialize the current non-secret vars before removing the git working copy.
		if (source?.envPath !== '') {
			await writeStackEnvFile(
				gitStack.stackName,
				envVars,
				gitStack.environmentId ?? null,
				source?.envPath ?? undefined
			);
		}

		await upsertStackSource({
			stackName: gitStack.stackName,
			environmentId: gitStack.environmentId ?? null,
			sourceType: 'internal',
			gitRepositoryId: null,
			gitStackId: null,
			composePath: composeResult.composePath,
			envPath: source?.envPath ?? null
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
