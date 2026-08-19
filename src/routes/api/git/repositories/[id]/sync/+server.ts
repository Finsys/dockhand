import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitRepository } from '$lib/server/db';
import { syncRepository, checkForUpdates } from '$lib/server/git';

/**
 * @openapi
 * summary: Sync (git pull) the local clone of a repository to the latest commit on its tracked branch
 * path: id:integer! Git repository ID (from GET /api/git/repositories)
 * resp-200: {success:boolean!, error:string}
 * resp-200-example: {"success":true}
 * resp-400: The id path segment is not a valid integer
 * resp-404: No repository exists with that ID
 * resp-500: The sync failed
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

		const result = await syncRepository(id);
		return json(result);
	} catch (error: any) {
		console.error('Failed to sync git repository:', error);
		return json({ success: false, error: error.message }, { status: 500 });
	}
};

/**
 * @openapi
 * summary: Check whether the tracked branch has new commits upstream without pulling them
 * path: id:integer! Git repository ID (from GET /api/git/repositories)
 * resp-200: {hasUpdates:boolean!, error:string}
 * resp-200-example: {"hasUpdates":false}
 * resp-400: The id path segment is not a valid integer
 * resp-404: No repository exists with that ID
 * resp-500: The update check failed
 */
export const GET: RequestHandler = async ({ params }) => {
	// Check for updates without syncing
	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid repository ID' }, { status: 400 });
		}

		const repository = await getGitRepository(id);
		if (!repository) {
			return json({ error: 'Repository not found' }, { status: 404 });
		}

		const result = await checkForUpdates(id);
		return json(result);
	} catch (error: any) {
		console.error('Failed to check for updates:', error);
		return json({ hasUpdates: false, error: error.message }, { status: 500 });
	}
};
