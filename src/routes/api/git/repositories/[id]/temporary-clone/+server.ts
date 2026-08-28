import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitRepository } from '$lib/server/db';
import { cloneGitRepositoryToPending } from '$lib/server/git-stack';
import { authorize } from '$lib/server/authorize';

/**
 * Clone a repository into an isolated create-flow directory. The returned
 * token is valid only for this repository and is consumed when a Git stack
 * adopts the checkout into its stack-owned directory.
 */
export const POST: RequestHandler = async ({ params, request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const repositoryId = Number(params.id);
	if (!Number.isInteger(repositoryId)) {
		return json({ error: 'Invalid repository ID' }, { status: 400 });
	}

	const repository = await getGitRepository(repositoryId);
	if (!repository) return json({ error: 'Repository not found' }, { status: 404 });

	let branch: string | null | undefined;
	try {
		const body = await request.json().catch(() => ({}));
		branch = typeof body?.branch === 'string' ? body.branch : undefined;
	} catch {
		branch = undefined;
	}

	const result = await cloneGitRepositoryToPending(repositoryId, branch);
	if (!result.success) {
		return json({ error: result.error || 'Failed to clone repository' }, { status: 500 });
	}

	return json({ token: result.token, commit: result.commit });
};
