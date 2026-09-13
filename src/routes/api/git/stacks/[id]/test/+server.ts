import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitStack } from '$lib/server/db';
import { testGitStack } from '$lib/server/git';
import { authorize } from '$lib/server/authorize';

/**
 * @openapi
 * summary: Test a git stack's repository access and compose configuration without deploying
 * path: id:integer! Git stack ID (from GET /api/git/stacks)
 * resp-200: {success:boolean!, error:string}
 * resp-200-example: {"success":true}
 * resp-403: Caller lacks the stacks:view permission for the stack's environment
 * resp-404: No git stack exists with that ID
 * resp-500: The test failed
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
		if (auth.authEnabled && !await auth.can('stacks', 'view', gitStack.environmentId || undefined)) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}

		const result = await testGitStack(id);
		return json(result);
	} catch (error) {
		console.error('Failed to test git stack:', error);
		return json({ error: 'Failed to test git stack' }, { status: 500 });
	}
};
