import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitRepository, getGitCredentials, type GitCredential } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { buildGitEnv, buildRepoUrl, execGit } from '$lib/server/git';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'view')) {
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
		let credential: GitCredential | null = null;

		if (repositoryId) {
			const repo = await getGitRepository(repositoryId);
			if (!repo) {
				return json({ error: 'Repository not found' }, { status: 404 });
			}
			repoUrl = repo.url;
			if (repo.credentialId) {
				const creds = await getGitCredentials();
				credential = (creds.find(c => c.id === repo.credentialId) || null) as GitCredential | null;
			}
		} else if (url) {
			repoUrl = url;
			if (credentialId) {
				const creds = await getGitCredentials();
				credential = (creds.find(c => c.id === credentialId) || null) as GitCredential | null;
			}
		} else {
			return json({ error: 'repositoryId or url is required' }, { status: 400 });
		}

		const env = await buildGitEnv(credential);
		const authenticatedUrl = buildRepoUrl(repoUrl, credential);

		// Use git ls-remote to list all branches
		const result = await execGit(
			['ls-remote', '--heads', '--refs', authenticatedUrl],
			process.cwd(),
			env
		);

		if (result.code !== 0) {
			return json({ error: 'Failed to fetch branches: ' + result.stderr }, { status: 500 });
		}

		const branches = result.stdout.split('\n')
			.filter(l => l.trim())
			.map(l => {
				const m = l.match(/refs\/heads\/(.+)$/);
				return m ? m[1] : null;
			})
			.filter(Boolean);

		return json({ branches });
	} catch (error: any) {
		console.error('Failed to fetch branches:', error);
		return json({ error: 'Failed to fetch branches' }, { status: 500 });
	}
};
