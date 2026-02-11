import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitStack } from '$lib/server/db';
import { deployGitStack } from '$lib/server/git';
import { authorize } from '$lib/server/authorize';
import { auditGitStack } from '$lib/server/audit';

export const POST: RequestHandler = async (event) => {
	const { params, cookies } = event;
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

		const result = await deployGitStack(id);

		// Audit log
		await auditGitStack(event, 'deploy', id, gitStack.stackName, gitStack.environmentId);

		return json(result);
	} catch (error) {
		console.error('Failed to deploy git stack:', error);
		return json({ error: 'Failed to deploy git stack' }, { status: 500 });
	}
};
