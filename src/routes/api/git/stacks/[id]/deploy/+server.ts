import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitStack } from '$lib/server/db';
import { deployGitStack } from '$lib/server/git';
import { authorize } from '$lib/server/authorize';
import { auditGitStack } from '$lib/server/audit';
import { createJobResponse } from '$lib/server/sse';

export const POST: RequestHandler = async (event) => {
	const { params, cookies, request } = event;
	const auth = await authorize(cookies);

	try {
		const id = parseInt(params.id);
		const gitStack = await getGitStack(id);
		if (!gitStack) {
			return json({ error: 'Git stack not found' }, { status: 404 });
		}

		// Permission check with environment context
		if (auth.authEnabled && !await auth.can('stacks', 'start', gitStack.environmentId || undefined)) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}

		// Per-run override for "only start services that were already running" (#1246).
		// Omitted (or no body at all) means: use the git stack's saved setting.
		const body = await request.json().catch(() => ({}));
		const { onlyRunningServices } = body as { onlyRunningServices?: boolean };

		return createJobResponse(async (send) => {
			try {
				const result = await deployGitStack(id, { onlyRunningServices });

				// Audit log
				await auditGitStack(event, 'deploy', id, gitStack.stackName, gitStack.environmentId);

				send('result', result);
			} catch (error) {
				console.error('Failed to deploy git stack:', error);
				send('result', { success: false, error: 'Failed to deploy git stack' });
			}
		}, event.request);
	} catch (error) {
		console.error('Failed to deploy git stack:', error);
		return json({ error: 'Failed to deploy git stack' }, { status: 500 });
	}
};
