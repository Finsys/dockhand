import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitRepository } from '$lib/server/db';
import { cloneGitRepositoryToPending } from '$lib/server/git-stack';
import { authorize } from '$lib/server/authorize';

/**
 * @openapi
 * summary: Clone a repository into a temporary checkout for the Git stack create flow, so its compose files can be browsed before the stack exists
 * description: The returned token is scoped to this repository and only usable with GET /api/git/repositories/{id}/browse. Checkouts are removed after one hour.
 * path: id:integer! Git repository ID (from GET /api/git/repositories)
 * body: {branch:string}
 * resp-200: {token:string!, commit:string}
 * resp-400: The id path segment is not a valid integer
 * resp-403: Permission denied (needs git:edit)
 * resp-404: No repository exists with that ID
 * resp-500: The clone failed
 */
export const POST: RequestHandler = async ({ params, request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const repositoryId = Number(params.id);
	if (!Number.isInteger(repositoryId)) {
		return json({ error: 'Invalid repository ID' }, { status: 400 });
	}

	const repository = await getGitRepository(repositoryId);
	if (!repository) return json({ error: 'Repository not found' }, { status: 404 });

	const body = await request.json().catch(() => ({}));
	const branch = typeof body?.branch === 'string' ? body.branch : undefined;

	const result = await cloneGitRepositoryToPending(repositoryId, branch);
	if (!result.success) {
		return json({ error: result.error || 'Failed to clone repository' }, { status: 500 });
	}

	return json({ token: result.token, commit: result.commit });
};
