import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitStack, getGitStacks } from '$lib/server/db';
import { startGitMigration } from '$lib/server/git-stack-migrate';
import { ConflictError } from '$lib/server/git-mode';
import { authorize } from '$lib/server/authorize';
import { audit } from '$lib/server/audit';

/**
 * @openapi
 * summary: Migrate a set of stack-model git stacks to the centralized model in one job
 * body: {stackIds:number[]!}
 * resp-200: {success:boolean, started:boolean, count:integer}
 * resp-400: stackIds is empty or not an array of numbers
 * resp-403: Permission denied (needs stacks:edit)
 * resp-409: A migration job is already running
 * resp-500: Failed to start the migration
 */
export const POST: RequestHandler = async (event) => {
	const { request, cookies } = event;
	const auth = await authorize(cookies);

	try {
		const data = await request.json();
		if (
			!Array.isArray(data.stackIds) ||
			data.stackIds.length === 0 ||
			data.stackIds.some((id: unknown) => typeof id !== 'number' || !Number.isInteger(id))
		) {
			return json({ error: 'stackIds must be a non-empty array of integers' }, { status: 400 });
		}

		const uniqueIds = [...new Set(data.stackIds as number[])];
		const allStacks = await getGitStacks();
		const eligible = uniqueIds.filter((id) => {
			const stack = allStacks.find((s) => s.id === id);
			return stack && stack.engine === 'stack';
		});

		if (eligible.length === 0) {
			return json({ error: 'None of the requested stacks are stack-model git stacks' }, { status: 400 });
		}

		if (auth.authEnabled && !await auth.can('stacks', 'edit')) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}

		try {
			await startGitMigration(eligible);
		} catch (err) {
			if (err instanceof ConflictError) {
				return json({ error: err.message }, { status: 409 });
			}
			throw err;
		}

		await audit(event, 'update', 'settings', {
			entityName: 'Git stacks',
			description: `Started migration of ${eligible.length} git stack(s) to centralized mode`,
			details: { stackIds: eligible }
		});

		return json({ success: true, started: true, count: eligible.length });
	} catch (error: any) {
		console.error('Failed to start git stack batch migration:', error);
		return json({ error: error.message || 'Failed to start git stack batch migration' }, { status: 500 });
	}
};