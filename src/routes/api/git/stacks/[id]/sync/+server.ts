import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitStack } from '$lib/server/db';
import { syncGitStack } from '$lib/server/git';
import { authorize } from '$lib/server/authorize';

/**
 * @openapi
 * summary: Sync (git pull) a git stack's repository clone to the latest tracked commit
 * path: id:integer! Git stack ID (from GET /api/git/stacks)
 * resp-200: {success:boolean!, error:string}
 * resp-200-example: {"success":true}
 * resp-403: Caller lacks the stacks:edit permission for the stack's environment
 * resp-404: No git stack exists with that ID
 * resp-500: The sync failed
 */
export const POST: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);

	try {
		const id = parseInt(params.id);
		const gitStack = await getGitStack(id);
		if (!gitStack) {
			return json({ error: 'Git stack not found' }, { status: 404 });
		}

		// Permission check with environment context
		if (auth.authEnabled && !await auth.can('stacks', 'edit', gitStack.environmentId || undefined)) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}

		const result = await syncGitStack(id);
		return json(result);
	} catch (error) {
		console.error('Failed to sync git stack:', error);
		return json({ error: 'Failed to sync git stack' }, { status: 500 });
	}
};
