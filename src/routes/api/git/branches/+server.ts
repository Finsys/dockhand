import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitRepository } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { listRemoteBranches } from '$lib/server/git';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const body = await request.json();
		const { repositoryId, url, credentialId } = body as {
			repositoryId?: number;
			url?: string;
			credentialId?: number | null;
		};

		let repoUrl: string;
		let credId: number | undefined;

		if (repositoryId) {
			const repo = await getGitRepository(repositoryId);
			if (!repo) {
				return json({ error: 'Repository not found' }, { status: 404 });
			}
			repoUrl = repo.url;
			credId = repo.credentialId ?? undefined;
		} else if (url) {
			repoUrl = url;
			credId = credentialId ?? undefined;
		} else {
			return json({ error: 'repositoryId or url is required' }, { status: 400 });
		}

		const result = await listRemoteBranches({ url: repoUrl, credentialId: credId });

		if (result.error) {
			return json({ error: 'Failed to fetch branches: ' + result.error }, { status: 500 });
		}

		return json({ branches: result.branches });
	} catch (error: any) {
		console.error('Failed to fetch branches:', error);
		return json({ error: 'Failed to fetch branches' }, { status: 500 });
	}
};
