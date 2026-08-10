import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitRepository } from '$lib/server/db';
import { deployFromRepository } from '$lib/server/git';

/**
 * @openapi
 * summary: Deploy the compose stack(s) defined in a git repository (clones/pulls, then runs docker compose)
 * path: id:integer! Git repository ID (from GET /api/git/repositories)
 * resp-200: {success:boolean!, error:string}
 * resp-200-example: {"success":true}
 * resp-400: The id path segment is not a valid integer
 * resp-404: No repository exists with that ID
 * resp-500: The deployment failed
 */
export const POST: RequestHandler = async ({ params }) => {
	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid repository ID' }, { status: 400 });
		}

		const repository = await getGitRepository(id);
		if (!repository) {
			return json({ error: 'Repository not found' }, { status: 404 });
		}

		const result = await deployFromRepository(id);
		return json(result);
	} catch (error: any) {
		console.error('Failed to deploy from git repository:', error);
		return json({ success: false, error: error.message }, { status: 500 });
	}
};
