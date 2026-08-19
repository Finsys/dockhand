import { json, text } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitRepository } from '$lib/server/db';
import { deployFromRepository } from '$lib/server/git';
import { auditGitRepository } from '$lib/server/audit';
import { verifyWebhookSignature } from '$lib/server/webhook-signature';

function detectSource(request: Request): string {
	if (request.headers.get('x-hub-signature-256')) return 'github';
	if (request.headers.get('x-gitlab-token')) return 'gitlab';
	return 'unknown';
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
 */
export const POST: RequestHandler = async (event) => {
	const { params, request } = event;
	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid repository ID' }, { status: 400 });
		}

		const repository = await getGitRepository(id);
		if (!repository) {
			return json({ error: 'Repository not found' }, { status: 404 });
		}

		if (!repository.webhookEnabled) {
			return json({ error: 'Webhook is not enabled for this repository' }, { status: 403 });
		}

		const source = detectSource(request);

		// A secret is mandatory: reject if none is configured.
		if (!repository.webhookSecret) {
			await auditGitRepository(event, 'webhook', id, repository.name, {
				method: 'POST', source, error: 'no_secret_configured'
			});
			return json({ error: 'Webhook secret is not configured for this repository' }, { status: 401 });
		}

		const payload = await request.text();
		const githubSignature = request.headers.get('x-hub-signature-256');
		const gitlabToken = request.headers.get('x-gitlab-token');

		const signature = githubSignature || gitlabToken;

		if (!verifyWebhookSignature(payload, signature, repository.webhookSecret)) {
			await auditGitRepository(event, 'webhook', id, repository.name, {
				method: 'POST', source, error: 'invalid_signature'
			});
			return json({ error: 'Invalid webhook signature' }, { status: 401 });
		}

		// Optionally check which branch was pushed (for GitHub)
		// const body = await request.json();
		// if (body.ref && body.ref !== `refs/heads/${repository.branch}`) {
		//   return json({ message: 'Push was not to tracked branch, skipping' });
		// }

		// Deploy from repository
		const result = await deployFromRepository(id);
		await auditGitRepository(event, 'webhook', id, repository.name, {
			method: 'POST', source, result: result.success ? 'deployed' : 'failed'
		});
		return json(result);
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
 */
export const GET: RequestHandler = async (event) => {
	const { params, url } = event;
	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid repository ID' }, { status: 400 });
		}

		const repository = await getGitRepository(id);
		if (!repository) {
			return json({ error: 'Repository not found' }, { status: 404 });
		}

		if (!repository.webhookEnabled) {
			return json({ error: 'Webhook is not enabled for this repository' }, { status: 403 });
		}

		// A secret is mandatory (see POST handler). Reject if none is configured.
		if (!repository.webhookSecret) {
			await auditGitRepository(event, 'webhook', id, repository.name, {
				method: 'GET', source: 'get', error: 'no_secret_configured'
			});
			return json({ error: 'Webhook secret is not configured for this repository' }, { status: 401 });
		}

		// Verify secret via query parameter for GET requests
		const secret = url.searchParams.get('secret');
		if (secret !== repository.webhookSecret) {
			await auditGitRepository(event, 'webhook', id, repository.name, {
				method: 'GET', source: 'get', error: 'invalid_secret'
			});
			return json({ error: 'Invalid webhook secret' }, { status: 401 });
		}

		// Deploy from repository
		const result = await deployFromRepository(id);
		await auditGitRepository(event, 'webhook', id, repository.name, {
			method: 'GET', source: 'get', result: result.success ? 'deployed' : 'failed'
		});
		return json(result);
	} catch (error: any) {
		console.error('Webhook GET error:', error);
		return json({ success: false, error: error.message }, { status: 500 });
	}
};
