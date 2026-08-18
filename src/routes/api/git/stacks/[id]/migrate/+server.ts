import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitStack } from '$lib/server/db';
import { startGitMigration } from '$lib/server/git-stack-migrate';
import { ConflictError } from '$lib/server/git-mode';
import { authorize } from '$lib/server/authorize';
import { auditGitStack } from '$lib/server/audit';

/**
 * @openapi
 * summary: Migrate a single stack-model git stack to the centralized model
 * path: id:integer The git stack id
 * resp-200: {success:boolean, started:boolean}
 * resp-403: Permission denied (needs stacks:edit)
 * resp-404: Git stack not found
 * resp-409: The stack is already centralized, is currently syncing, or a migration job is already running
 * resp-500: Failed to start the migration
 */
export const POST: RequestHandler = async (event) => {
	const { params, cookies } = event;
	const auth = await authorize(cookies);

	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid stack ID' }, { status: 400 });
		}

		const stack = await getGitStack(id);
		if (!stack) {
			return json({ error: 'Git stack not found' }, { status: 404 });
		}

		if (auth.authEnabled && !await auth.can('stacks', 'edit', stack.environmentId || undefined)) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}

		if (stack.engine === 'centralized') {
			return json({ error: 'This stack is already using centralized Git mode' }, { status: 409 });
		}

		if (stack.syncStatus === 'syncing') {
			return json({ error: 'This stack is currently syncing; wait for it to finish before migrating' }, { status: 409 });
		}

		try {
			await startGitMigration([id]);
		} catch (err) {
			if (err instanceof ConflictError) {
				return json({ error: err.message }, { status: 409 });
			}
			throw err;
		}

		await auditGitStack(event, 'migrate', id, stack.stackName, stack.environmentId);

		return json({ success: true, started: true, stackId: id });
	} catch (error: any) {
		console.error('Failed to start git stack migration:', error);
		return json({ error: error.message || 'Failed to start git stack migration' }, { status: 500 });
	}
};