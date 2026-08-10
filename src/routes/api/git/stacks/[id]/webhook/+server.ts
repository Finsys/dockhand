import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitStack } from '$lib/server/db';
import { deployGitStack } from '$lib/server/git';
import { auditGitStack } from '$lib/server/audit';
import { verifyWebhookSignature } from '$lib/server/webhook-signature';

function detectSource(request: Request): string {
	if (request.headers.get('x-hub-signature-256')) return 'github';
	if (request.headers.get('x-gitlab-token')) return 'gitlab';
	return 'unknown';
}

/**
 * @openapi
 * summary: Webhook trigger (GitHub/GitLab) that deploys a git stack when its signature/token verifies
 * description: Public endpoint authenticated by the stack's webhook secret via `X-Hub-Signature-256` (GitHub) or `X-Gitlab-Token` (GitLab); the raw request body is used for HMAC verification.
 * path: id:integer! Git stack ID (from GET /api/git/stacks)
 * resp-200: {success:boolean, skipped:boolean, error:string}
 * resp-200-example: {"success":true,"skipped":false}
 * resp-400: The id path segment is not a valid integer
 * resp-401: The webhook signature or token did not verify
 * resp-403: Webhooks are not enabled for this stack
 * resp-404: No git stack exists with that ID
 * resp-500: The deployment triggered by the webhook failed
 */
export const POST: RequestHandler = async (event) => {
	const { params, request } = event;
	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid stack ID' }, { status: 400 });
		}

		const gitStack = await getGitStack(id);
		if (!gitStack) {
			return json({ error: 'Git stack not found' }, { status: 404 });
		}

		if (!gitStack.webhookEnabled) {
			return json({ error: 'Webhook is not enabled for this stack' }, { status: 403 });
		}

		const source = detectSource(request);

		// A secret is mandatory: reject if none is configured.
		if (!gitStack.webhookSecret) {
			await auditGitStack(event, 'webhook', id, gitStack.stackName, gitStack.environmentId, {
				method: 'POST', source, error: 'no_secret_configured'
			});
			return json({ error: 'Webhook secret is not configured for this stack' }, { status: 401 });
		}

		const payload = await request.text();
		const githubSignature = request.headers.get('x-hub-signature-256');
		const gitlabToken = request.headers.get('x-gitlab-token');

		const signature = githubSignature || gitlabToken;

		if (!verifyWebhookSignature(payload, signature, gitStack.webhookSecret)) {
			await auditGitStack(event, 'webhook', id, gitStack.stackName, gitStack.environmentId, {
				method: 'POST', source, error: 'invalid_signature'
			});
			return json({ error: 'Invalid webhook signature' }, { status: 401 });
		}

		// Deploy the git stack (syncs and deploys only if there are changes)
		const result = await deployGitStack(id, { force: false });
		await auditGitStack(event, 'webhook', id, gitStack.stackName, gitStack.environmentId, {
			method: 'POST', source, result: result.skipped ? 'skipped' : result.success ? 'deployed' : 'failed'
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
 * summary: GET webhook trigger for a git stack, with the secret passed as the `secret` query parameter
 * path: id:integer! Git stack ID (from GET /api/git/stacks)
 * query: secret:string Webhook secret; required only if the stack has a webhook secret configured
 * resp-200: {success:boolean, skipped:boolean, error:string}
 * resp-200-example: {"success":true,"skipped":false}
 * resp-400: The id path segment is not a valid integer
 * resp-401: The provided secret did not match the stack's webhook secret
 * resp-403: Webhooks are not enabled for this stack
 * resp-404: No git stack exists with that ID
 * resp-500: The deployment triggered by the webhook failed
 */
export const GET: RequestHandler = async (event) => {
	const { params, url } = event;
	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid stack ID' }, { status: 400 });
		}

		const gitStack = await getGitStack(id);
		if (!gitStack) {
			return json({ error: 'Git stack not found' }, { status: 404 });
		}

		if (!gitStack.webhookEnabled) {
			return json({ error: 'Webhook is not enabled for this stack' }, { status: 403 });
		}

		// A secret is mandatory (see POST handler). Reject if none is configured.
		if (!gitStack.webhookSecret) {
			await auditGitStack(event, 'webhook', id, gitStack.stackName, gitStack.environmentId, {
				method: 'GET', source: 'get', error: 'no_secret_configured'
			});
			return json({ error: 'Webhook secret is not configured for this stack' }, { status: 401 });
		}

		// Verify secret via query parameter for GET requests
		const secret = url.searchParams.get('secret');
		if (secret !== gitStack.webhookSecret) {
			await auditGitStack(event, 'webhook', id, gitStack.stackName, gitStack.environmentId, {
				method: 'GET', source: 'get', error: 'invalid_secret'
			});
			return json({ error: 'Invalid webhook secret' }, { status: 401 });
		}

		// Deploy the git stack (syncs and deploys only if there are changes)
		const result = await deployGitStack(id, { force: false });
		await auditGitStack(event, 'webhook', id, gitStack.stackName, gitStack.environmentId, {
			method: 'GET', source: 'get', result: result.skipped ? 'skipped' : result.success ? 'deployed' : 'failed'
		});
		return json(result);
	} catch (error: any) {
		console.error('Webhook GET error:', error);
		return json({ success: false, error: error.message }, { status: 500 });
	}
};
