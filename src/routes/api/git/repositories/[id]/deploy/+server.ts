import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitRepository } from '$lib/server/db';
import { deployFromRepository } from '$lib/server/git';
import { authorize } from '$lib/server/authorize';
import { deniesEnvScope } from '$lib/server/env-scope';

/**
 * @openapi
 * summary: Deploy the compose stack(s) defined in a git repository (clones/pulls, then runs docker compose)
 * path: id:integer! Git repository ID (from GET /api/git/repositories)
 * resp-200: {success:boolean!, error:string}
 * resp-200-example: {"success":true}
 * resp-400: The id path segment is not a valid integer
 * resp-403: Caller lacks git:edit, or stacks:create and stacks:start on the repository's environment, or access to that environment (an Enterprise non-admin needs the repository to have one)
 * resp-404: No repository exists with that ID
 * resp-500: The deployment failed
 */
export const POST: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid repository ID' }, { status: 400 });
		}

		const repository = await getGitRepository(id);
		if (!repository) {
			return json({ error: 'Repository not found' }, { status: 404 });
		}

		// This runs a compose deploy on the repository's environment (Dockhand's own daemon
		// when it has none), so it needs the same stack rights as a git-stack deploy there.
		const envId = repository.environmentId ?? undefined;
		if (
			auth.authEnabled &&
			(!(await auth.can('stacks', 'create', envId)) || !(await auth.can('stacks', 'start', envId)))
		) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}
		if (await deniesEnvScope(auth, envId)) {
			return json({ error: 'Access denied to this environment' }, { status: 403 });
		}

		const result = await deployFromRepository(id);
		return json(result);
	} catch (error: any) {
		console.error('Failed to deploy from git repository:', error);
		return json({ success: false, error: error.message }, { status: 500 });
	}
};
