import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getGitRepository,
	updateGitRepository,
	deleteGitRepository,
	getGitCredentials,
	getGitStacksByRepositoryId,
	repositoryHasCentralizedStack
} from '$lib/server/db';
import { deleteRepositoryFiles, deleteGitStackFiles, renameRepositoryFiles, syncRepositoryExclusive, findRepoNameSanitizationCollision } from '$lib/server/git';
import { assertNotMigrating } from '$lib/server/git-migration-guard';
import { createJob, completeJob, failJob } from '$lib/server/jobs';
import { authorize } from '$lib/server/authorize';
import { auditGitRepository } from '$lib/server/audit';
import { computeAuditDiff } from '$lib/utils/diff';
import { registerSchedule, unregisterSchedule } from '$lib/server/scheduler';
import { WEBHOOK_SECRET_REQUIRED_ERROR } from '$lib/utils/webhook-secret';

/**
 * @openapi
 * summary: Get a single git repository by ID
 * path: id:integer! Git repository ID (from GET /api/git/repositories)
 * resp-200: {id:integer!, name:string!, url:string!, branch:string!, credentialId:integer}
 * resp-400: The id path segment is not a valid integer
 * resp-403: Caller lacks the git:view permission
 * resp-404: No repository exists with that ID
 * resp-500: Failed to read the git repository
 */
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

/**
 * @openapi
 * summary: Update a git repository's basic fields (name/url/branch/credential)
 * description: credentialId from GET /api/git/credentials.
 * path: id:integer! Git repository ID (from GET /api/git/repositories)
 * body: {name:string, url:string, branch:string, credentialId:integer}
 * body-example: {"name":"homelab","url":"https://github.com/example/homelab.git","branch":"production","credentialId":2}
 * resp-200: {id:integer!, name:string!, url:string!, branch:string!, credentialId:integer}
 * resp-400: Invalid id, an invalid credentialId, or a duplicate repository name
 * resp-403: Caller lacks the git:edit permission
 * resp-404: No repository exists with that ID
 * resp-500: The update failed or the repository could not be persisted
 */
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

		// Block only when THIS repository is being provisioned by a migration (narrow lock).
		const locked = await assertNotMigrating([], [id]);
		if (locked) return locked;

		const hasCentralized = await repositoryHasCentralizedStack(id);

		// Validate credential if provided
		if (data.credentialId) {
			const credentials = await getGitCredentials();
			const credential = credentials.find(c => c.id === data.credentialId);
			if (!credential) {
				return json({ error: 'Invalid credential ID' }, { status: 400 });
			}
		}

		if (typeof data.name === 'string' && data.name !== existing.name) {
			const nameCollision = await findRepoNameSanitizationCollision(data.name, id);
			if (nameCollision) {
				return json({
					error: `Repository name conflicts with existing repository "${nameCollision}" after filesystem sanitization. Choose a more distinct name.`
				}, { status: 400 });
			}
		}

		// A secret is mandatory when the webhook is enabled (centralized only).
		// Evaluate the effective post-update state (PUT is partial).
		const effWebhookEnabled = data.webhookEnabled !== undefined ? data.webhookEnabled : existing.webhookEnabled;
		const effWebhookSecret = data.webhookSecret !== undefined ? data.webhookSecret : existing.webhookSecret;
		if (hasCentralized && effWebhookEnabled && !effWebhookSecret?.trim()) {
			return json({ error: WEBHOOK_SECRET_REQUIRED_ERROR }, { status: 400 });
		}

		const effAutoUpdate = hasCentralized ? (data.autoUpdate ?? existing.autoUpdate) : undefined;
		const effAutoUpdateSchedule = effAutoUpdate
			? (data.autoUpdateSchedule ?? existing.autoUpdateSchedule ?? null)
			: null;
		const effAutoUpdateCron = effAutoUpdate
			? (data.autoUpdateCron ?? existing.autoUpdateCron ?? null)
			: null;

		// Update repository fields. Repos with no centralized stacks update only
		// identity fields — repo-level schedule/webhook are centralized concepts.
		const repository = await updateGitRepository(id, hasCentralized
			? {
				name: data.name,
				url: data.url,
				branch: data.branch,
				credentialId: data.credentialId,
				autoUpdate: data.autoUpdate,
				autoUpdateSchedule: effAutoUpdateSchedule,
				autoUpdateCron: effAutoUpdateCron,
				webhookEnabled: data.webhookEnabled,
				webhookSecret: data.webhookSecret
			}
			: {
				name: data.name,
				url: data.url,
				branch: data.branch,
				credentialId: data.credentialId
			}
		);

		if (!repository) {
			return json({ error: 'Failed to update repository' }, { status: 500 });
		}

		// Compute diff for audit
		const diff = computeAuditDiff(existing, repository);

		// Audit log
		await auditGitRepository(event, 'update', repository.id, repository.name, diff);

		if (!hasCentralized) {
			// No shared clone, no repo-level schedule, no resync — thin record.
			return json(repository);
		}

		// Manage schedule if auto-update settings changed
		if (repository.autoUpdate) {
			await registerSchedule(repository.id, 'git_repository_sync', null);
		} else {
			unregisterSchedule(repository.id, 'git_repository_sync');
		}

		// Rename on-disk clone if the display name changed (path is name-based)
		if (existing.name !== repository.name) {
			renameRepositoryFiles(existing.name, repository.name);
		}

		// Only re-sync when clone identity changes (URL, branch, or credentials)
		const needsResync =
			existing.url !== repository.url ||
			existing.branch !== repository.branch ||
			existing.credentialId !== repository.credentialId;

		if (!needsResync) {
			return json(repository);
		}

		const job = createJob();
		syncRepositoryExclusive(id).then((result) => {
			if (result.success) {
				completeJob(job, { success: true, commit: result.commit });
			} else {
				failJob(job, result.error ?? 'Clone failed');
			}
		}).catch((err: unknown) => {
			failJob(job, err instanceof Error ? err.message : String(err));
		});

		return json({ ...repository, jobId: job.id });
	} catch (error: any) {
		console.error('Failed to update git repository:', error);
		if (error.message?.includes('UNIQUE constraint failed')) {
			return json({ error: 'A repository with this name already exists' }, { status: 400 });
		}
		return json({ error: 'Failed to update git repository' }, { status: 500 });
	}
};

/**
 * @openapi
 * summary: Delete a git repository, first removing the clone directories of every git stack it backs
 * path: id:integer! Git repository ID (from GET /api/git/repositories)
 * resp-200: {success:boolean!}
 * resp-200-example: {"success":true}
 * resp-400: The id path segment is not a valid integer
 * resp-403: Caller lacks the git:delete permission
 * resp-404: No repository exists with that ID
 * resp-500: The deletion failed
 */
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

		// Block only when THIS repository is being provisioned by a migration (narrow lock).
		const locked = await assertNotMigrating([], [id]);
		if (locked) return locked;

		// Delete git stack clone directories before cascade deletes the DB rows
		const stacks = await getGitStacksByRepositoryId(id);
		console.log(`[GitStack] Repository "${repository.name}" (id=${id}) deletion affects ${stacks.length} stacks: ${stacks.map(s => s.stackName).join(', ')}`);
		const hasCentralized = stacks.some((s) => s.engine === 'centralized');
		for (const stack of stacks) {
			// Stack-model stacks also drop their per-stack git_stack_sync schedule.
			if (stack.engine === 'stack') {
				unregisterSchedule(stack.id, 'git_stack_sync');
			}
			await deleteGitStackFiles(stack.id, stack.stackName, stack.environmentId);
		}

		if (hasCentralized) {
			// Delete repository clone directory
			deleteRepositoryFiles(repository.name, id);
		}

		// Unregister repo-level schedule (centralized stacks only).
		unregisterSchedule(id, 'git_repository_sync');

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
