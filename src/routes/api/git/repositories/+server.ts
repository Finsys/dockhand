import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getGitRepositories,
	createGitRepository,
	getGitCredentials
} from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { auditGitRepository } from '$lib/server/audit';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		// Note: envId parameter is kept for backwards compatibility but repositories
		// are now global (not tied to environments). Use git stacks for env-specific deployments.
		const repositories = await getGitRepositories();
		return json(repositories);
	} catch (error) {
		console.error('Failed to get git repositories:', error);
		return json({ error: 'Failed to get git repositories' }, { status: 500 });
	}
};

export const POST: RequestHandler = async (event) => {
	const { request, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'create')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const data = await request.json();

		if (!data.name || typeof data.name !== 'string') {
			return json({ error: 'Name is required' }, { status: 400 });
		}

		if (!data.url || typeof data.url !== 'string') {
			return json({ error: 'Repository URL is required' }, { status: 400 });
		}

		// Validate credential if provided
		if (data.credentialId) {
			const credentials = await getGitCredentials();
			const credential = credentials.find(c => c.id === data.credentialId);
			if (!credential) {
				return json({ error: 'Invalid credential ID' }, { status: 400 });
			}
		}

		// Create repository with just the basic fields
		// Deployment-specific config (composePath, autoUpdate, webhook) now belongs to git_stacks
		const repository = await createGitRepository({
			name: data.name,
			url: data.url,
			branch: data.branch || 'main',
			credentialId: data.credentialId || null
		});

		// Audit log
		await auditGitRepository(event, 'create', repository.id, repository.name);

		return json(repository);
	} catch (error: any) {
		console.error('Failed to create git repository:', error);
		if (error.message?.includes('UNIQUE constraint failed')) {
			return json({ error: 'A repository with this name already exists' }, { status: 400 });
		}
		return json({ error: 'Failed to create git repository' }, { status: 500 });
	}
};
