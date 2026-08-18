import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getGitRepositories,
	getGitRepository,
	createGitRepository,
	getGitCredentials
} from '$lib/server/db';
import { provisionSharedClone, findRepoNameSanitizationCollision } from '$lib/server/git';
import { getDesiredGitMode } from '$lib/server/git-mode';
import { assertNotMigrating } from '$lib/server/git-migration-guard';
import { createJob, completeJob, failJob } from '$lib/server/jobs';
import { authorize } from '$lib/server/authorize';
import { auditGitRepository } from '$lib/server/audit';
import { registerSchedule } from '$lib/server/scheduler';
import { WEBHOOK_SECRET_REQUIRED_ERROR } from '$lib/utils/webhook-secret';

/**
 * @openapi
 * summary: List all git repositories (repositories are global, not scoped to an environment)
 * resp-200: array<{id:integer!, name:string!, url:string!, branch:string!, credentialId:integer}>
 * resp-200-example: [{"id":1,"name":"homelab","url":"https://github.com/example/homelab.git","branch":"main","credentialId":2}]
 * resp-403: Caller lacks the git:view permission
 * resp-500: Failed to read git repositories
 */
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

/**
 * @openapi
 * summary: Create a git repository (branch defaults to main); deployment config lives on git stacks, not here
 * description: credentialId from GET /api/git/credentials.
 * body: {name:string!, url:string!, branch:string, credentialId:integer}
 * body-example: {"name":"homelab","url":"https://github.com/example/homelab.git","branch":"main","credentialId":2}
 * resp-200: {id:integer!, name:string!, url:string!, branch:string!, credentialId:integer}
 * resp-400: Missing name/url, an invalid credentialId, or a duplicate repository name
 * resp-403: Caller lacks the git:create permission
 * resp-500: Failed to create the git repository
 */
export const POST: RequestHandler = async (event) => {
	const { request, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'create')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const data = await request.json();

		// A migration only locks the repos it is provisioning; a brand-new repo is
		// never in scope, so no narrow-lock ids to pass (create is always allowed).
		const locked = await assertNotMigrating();
		if (locked) return locked;

		if (!data.name || typeof data.name !== 'string') {
			return json({ error: 'Name is required' }, { status: 400 });
		}

		if (!data.url || typeof data.url !== 'string') {
			return json({ error: 'Repository URL is required' }, { status: 400 });
		}

		const model = await getDesiredGitMode();

		const nameCollision = await findRepoNameSanitizationCollision(data.name);
		if (nameCollision) {
			return json({
				error: `Repository name conflicts with existing repository "${nameCollision}" after filesystem sanitization. Choose a more distinct name.`
			}, { status: 400 });
		}

		// Validate credential if provided
		if (data.credentialId) {
			const credentials = await getGitCredentials();
			const credential = credentials.find(c => c.id === data.credentialId);
			if (!credential) {
				return json({ error: 'Invalid credential ID' }, { status: 400 });
			}
		}

		// A secret is mandatory when the webhook is enabled (centralized only).
		if (model === 'centralized' && data.webhookEnabled && !data.webhookSecret?.trim()) {
			return json({ error: WEBHOOK_SECRET_REQUIRED_ERROR }, { status: 400 });
		}

		// Create repository. Stack mode keeps it a thin record — no repo-level
		// schedule/webhook and no clone on save (syncs/webhooks are per stack).
		const repository = await createGitRepository(model === 'centralized'
			? {
				name: data.name,
				url: data.url,
				branch: data.branch || 'main',
				credentialId: data.credentialId || null,
				autoUpdate: data.autoUpdate || false,
				autoUpdateSchedule: data.autoUpdate ? (data.autoUpdateSchedule || 'daily') : undefined,
				autoUpdateCron: data.autoUpdate ? (data.autoUpdateCron || '0 3 * * *') : undefined,
				webhookEnabled: data.webhookEnabled || false,
				webhookSecret: data.webhookSecret || null
			}
			: {
				name: data.name,
				url: data.url,
				branch: data.branch || 'main',
				credentialId: data.credentialId || null
			}
		);

		// Audit log
		await auditGitRepository(event, 'create', repository.id, repository.name);

		// Register schedule if auto-update is enabled (centralized mode)
		if (model === 'centralized' && repository.autoUpdate) {
			await registerSchedule(repository.id, 'git_repository_sync', null);
		}

		if (model === 'stack') {
			return json(repository);
		}

		// The web UI sends X-Dockhand-Async to get a background clone with live
		// progress (returns immediately with a jobId to poll). Without the header
		// the clone runs synchronously and the finished repository is returned,
		// preserving the synchronous contract old API token scripts rely on.
		const asyncRequested = request.headers.get('x-dockhand-async') === '1';
		if (asyncRequested) {
			// Create a job to track the clone progress so the frontend can poll for the result
			const job = createJob();
			provisionSharedClone(repository.id).then((result) => {
				if (result.success) {
					completeJob(job, { success: true, commit: result.commit });
				} else {
					failJob(job, result.error ?? 'Clone failed');
				}
			}).catch((err: unknown) => {
				failJob(job, err instanceof Error ? err.message : String(err));
			});

			return json({ ...repository, cloneStarted: true, jobId: job.id });
		}

		// Synchronous contract: wait for the clone to finish so callers
		// that assumed it was done on return keep working. syncRepositoryExclusive
		// never throws — failures are reported via the returned SyncResult and
		// persisted on the repository row (syncStatus/syncError), so the response
		// always carries the repo in its final state.
		const syncResult = await provisionSharedClone(repository.id);
		const refreshed = (await getGitRepository(repository.id)) ?? repository;
		if (!syncResult.success) {
			return json({
				...refreshed,
				syncStatus: 'error',
				syncError: syncResult.error ?? 'Clone failed'
			});
		}
		return json(refreshed);
	} catch (error: any) {
		console.error('Failed to create git repository:', error);
		if (error.message?.includes('UNIQUE constraint failed')) {
			return json({ error: 'A repository with this name already exists' }, { status: 400 });
		}
		return json({ error: 'Failed to create git repository' }, { status: 500 });
	}
};
