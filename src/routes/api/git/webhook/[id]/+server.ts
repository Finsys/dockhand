import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitRepository, repositoryHasCentralizedStack, type GitRepository } from '$lib/server/db';
import { triggerGitRepositorySyncFromWebhook } from '$lib/server/scheduler';
import { auditGitRepository } from '$lib/server/audit';
import { handleGitWebhookRequest, type GitWebhookHandlerOptions } from '$lib/server/git-webhook-handler';
import { assertNotMigrating } from '$lib/server/git-migration-guard';

const options: GitWebhookHandlerOptions<GitRepository> = {
	load: (id) => getGitRepository(id),
	audit: async (event, id, repository, meta) => {
		await auditGitRepository(event, 'webhook', id, repository.name, meta);
	},
	trigger: (id) => triggerGitRepositorySyncFromWebhook(id),
	invalidIdMessage: 'Invalid repository ID',
	notFoundMessage: 'Repository not found',
	webhookDisabledMessage: 'Webhook is not enabled for this repository',
	secretNotConfiguredMessage: 'Webhook secret is not configured for this repository',
	successMessage: 'Repository sync triggered'
};

/** Repository-level webhooks are a centralized concept: only repos with at
 * least one centralized-model stack have one (stack-model stacks use per-stack
 * webhook URLs). */
async function noCentralizedMembers(id: number): Promise<Response | null> {
	if (!(await repositoryHasCentralizedStack(id))) {
		return json({ error: 'Repository has no centralized stacks; webhooks are configured per stack' }, { status: 404 });
	}
	return null;
}

/**
 * @openapi
 * summary: Webhook trigger (GitHub/GitLab) that deploys from a git repository when its signature/token verifies
 * description: Public endpoint authenticated by the repository's webhook secret via `X-Hub-Signature-256` (GitHub) or `X-Gitlab-Token` (GitLab); the raw request body is used for HMAC verification.
 * path: id:integer! Git repository ID (from GET /api/git/repositories)
 * resp-200: {success:boolean, error:string}
 * resp-200-example: {"success":true}
 * resp-400: The id path segment is not a valid integer
 * resp-401: The webhook signature or token did not verify
 * resp-403: Webhooks are not enabled for this repository
 * resp-404: No repository exists with that ID
 * resp-500: The deployment triggered by the webhook failed
 *
 * Repository-level git webhook. See git-webhook-handler.ts for the shared flow.
 */
export const POST: RequestHandler = async (event) => {
	try {
		const id = parseInt(event.params.id ?? '');
		const disabled = isNaN(id) ? null : await noCentralizedMembers(id);
		if (disabled) return disabled;
		const locked = isNaN(id) ? null : await assertNotMigrating([], [id]);
		if (locked) return locked;
		return await handleGitWebhookRequest(event, options);
	} catch (error: any) {
		console.error('Webhook error:', error);
		return json({ success: false, error: error.message }, { status: 500 });
	}
};

// Also support GET for simple polling/manual triggers
/**
 * @openapi
 * summary: GET webhook trigger for a git repository, with the secret passed as the `secret` query parameter
 * path: id:integer! Git repository ID (from GET /api/git/repositories)
 * query: secret:string Webhook secret; required only if the repository has a webhook secret configured
 * resp-200: {success:boolean, error:string}
 * resp-200-example: {"success":true}
 * resp-400: The id path segment is not a valid integer
 * resp-401: The provided secret did not match the repository's webhook secret
 * resp-403: Webhooks are not enabled for this repository
 * resp-404: No repository exists with that ID
 * resp-500: The deployment triggered by the webhook failed
 * 
 * GET is kept for simple polling/manual triggers, verified by the webhook
 * secret passed as the ?secret= query parameter.
 */
export const GET: RequestHandler = async (event) => {
	try {
		const id = parseInt(event.params.id ?? '');
		const disabled = isNaN(id) ? null : await noCentralizedMembers(id);
		if (disabled) return disabled;
		const locked = isNaN(id) ? null : await assertNotMigrating([], [id]);
		if (locked) return locked;
		return await handleGitWebhookRequest(event, options);
	} catch (error: any) {
		console.error('Webhook GET error:', error);
		return json({ success: false, error: error.message }, { status: 500 });
	}
};
