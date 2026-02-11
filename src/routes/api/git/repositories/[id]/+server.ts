import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getGitRepository,
	updateGitRepository,
	deleteGitRepository,
	getGitCredentials
} from '$lib/server/db';
import { deleteRepositoryFiles } from '$lib/server/git';
import { authorize } from '$lib/server/authorize';
import { auditGitRepository } from '$lib/server/audit';
import { computeAuditDiff } from '$lib/utils/diff';

export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'view')) {
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

		return json(repository);
	} catch (error) {
		console.error('Failed to get git repository:', error);
		return json({ error: 'Failed to get git repository' }, { status: 500 });
	}
};

export const PUT: RequestHandler = async (event) => {
	const { params, request, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid repository ID' }, { status: 400 });
		}

		const existing = await getGitRepository(id);
		if (!existing) {
			return json({ error: 'Repository not found' }, { status: 404 });
		}

		const data = await request.json();

		// Validate credential if provided
		if (data.credentialId) {
			const credentials = await getGitCredentials();
			const credential = credentials.find(c => c.id === data.credentialId);
			if (!credential) {
				return json({ error: 'Invalid credential ID' }, { status: 400 });
			}
		}

		// Update only the basic repository fields
		// Deployment-specific config (composePath, autoUpdate, webhook) now belongs to git_stacks
		const repository = await updateGitRepository(id, {
			name: data.name,
			url: data.url,
			branch: data.branch,
			credentialId: data.credentialId
		});

		if (!repository) {
			return json({ error: 'Failed to update repository' }, { status: 500 });
		}

		// Compute diff for audit
		const diff = computeAuditDiff(existing, repository);

		// Audit log
		await auditGitRepository(event, 'update', repository.id, repository.name, diff);

		return json(repository);
	} catch (error: any) {
		console.error('Failed to update git repository:', error);
		if (error.message?.includes('UNIQUE constraint failed')) {
			return json({ error: 'A repository with this name already exists' }, { status: 400 });
		}
		return json({ error: 'Failed to update git repository' }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async (event) => {
	const { params, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'delete')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid repository ID' }, { status: 400 });
		}

		// Get repository name before deletion for audit log
		const repository = await getGitRepository(id);
		if (!repository) {
			return json({ error: 'Repository not found' }, { status: 404 });
		}

		// Delete repository files first
		deleteRepositoryFiles(id);

		const deleted = await deleteGitRepository(id);
		if (!deleted) {
			return json({ error: 'Failed to delete repository' }, { status: 500 });
		}

		// Audit log
		await auditGitRepository(event, 'delete', id, repository.name);

		return json({ success: true });
	} catch (error) {
		console.error('Failed to delete git repository:', error);
		return json({ error: 'Failed to delete git repository' }, { status: 500 });
	}
};
