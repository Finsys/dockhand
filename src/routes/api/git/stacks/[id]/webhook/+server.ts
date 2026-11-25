import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitStack, getStackEnvVars, setStackImageTag } from '$lib/server/db';
import { deployGitStack } from '$lib/server/git';
import { auditGitStack } from '$lib/server/audit';
import { verifyWebhookSignature, timingSafeStringEqual } from '$lib/server/webhook-signature';
import { decideWebhookSecretPolicy, allowSecretlessWebhook } from '$lib/server/webhook-secret-policy';
import { decideWebhookRefSkip } from '$lib/server/git-webhook-ref';
import { parseWebhookImageTag, resolveWebhookImageTag } from '$lib/server/git-webhook-image-tag';
import { isConcurrentSyncSkip } from '$lib/server/git-deploy-policy';

async function deployWebhook(id: number, stack: NonNullable<Awaited<ReturnType<typeof getGitStack>>>, tagValues: string[]) {
	let tagQuery: ReturnType<typeof parseWebhookImageTag>;
	try { tagQuery = parseWebhookImageTag(tagValues); }
	catch (error) { return json({ error: error instanceof Error ? error.message : 'Invalid IMAGE_TAG' }, { status: 400 }); }
	const { supplied, raw } = tagQuery;
	const result = await deployGitStack(id, {
		force: supplied, pullImages: supplied, triggeredBy: 'webhook',
		prepare: supplied ? async () => {
			const variables = await getStackEnvVars(stack.stackName, stack.environmentId ?? null, false);
			const current = variables.find(v => v.key === 'IMAGE_TAG')?.value;
			const tag = resolveWebhookImageTag(raw, current);
			if (tag !== current) await setStackImageTag(stack.stackName, stack.environmentId ?? null, tag);
		} : undefined
	});
	if (!result.success && isConcurrentSyncSkip(result.error)) return json(result, { status: 409 });
	return json(result, { status: result.success ? 200 : 500 });
}

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
 * query: IMAGE_TAG:string Docker image tag; an explicit value triggers a deployment and image pull
 * resp-200: {success:boolean, skipped:boolean, error:string, output:string}
 * resp-200-example: {"success":true,"skipped":false}
 * resp-400: The id path segment is not a valid integer
 * resp-401: The webhook signature or token did not verify
 * resp-403: Webhooks are not enabled for this stack
 * resp-404: No git stack exists with that ID
 * resp-500: The deployment triggered by the webhook failed
 */
export const POST: RequestHandler = async (event) => {
	const { params, request, url } = event;
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

		const policy = decideWebhookSecretPolicy(!!gitStack.webhookSecret, allowSecretlessWebhook());
		if (policy.action === 'reject-no-secret') {
			await auditGitStack(event, 'webhook', id, gitStack.stackName, gitStack.environmentId, {
				method: 'POST', source, error: 'no_secret_configured'
			});
			return json({ error: 'Webhook secret is not configured for this stack' }, { status: 401 });
		}
		// The raw body is needed both to verify the HMAC and to read the push ref. A
		// repository webhook fires for every branch, so a push that is not for the branch
		// this stack tracks is dropped before deploy; a skip returns 200 so the provider
		// does not retry. Applies to both the verified and the secretless-opt-in paths.
		const payload = await request.text();
		const refSkip = decideWebhookRefSkip(payload, gitStack.branch || gitStack.repository.branch);
		const skipResponse = async (ref: string, branch: string) => {
			await auditGitStack(event, 'webhook', id, gitStack.stackName, gitStack.environmentId, {
				method: 'POST', source, result: 'skipped'
			});
			return json({ success: true, skipped: true, output: `Push was to ${ref}, not tracked branch ${branch}` });
		};

		if (policy.action === 'deploy-unverified') {
			// ALLOW_WEBHOOKS_WITHOUT_SECRET opt-in (isolated network): deploy without
			// verification, but record the unverified trigger in the audit trail.
			if (refSkip.skip) return skipResponse(refSkip.ref, refSkip.trackedBranch);
			const response = await deployWebhook(id, gitStack, url.searchParams.getAll('IMAGE_TAG'));
			await auditGitStack(event, 'webhook', id, gitStack.stackName, gitStack.environmentId, {
				method: 'POST', source, verification: 'skipped_no_secret', status: response.status
			});
			return response;
		}

		// policy.action === 'verify' here, so a secret is present.
		const webhookSecret = gitStack.webhookSecret as string;
		const githubSignature = request.headers.get('x-hub-signature-256');
		const gitlabToken = request.headers.get('x-gitlab-token');

		const signature = githubSignature || gitlabToken;

		if (!verifyWebhookSignature(payload, signature, webhookSecret)) {
			await auditGitStack(event, 'webhook', id, gitStack.stackName, gitStack.environmentId, {
				method: 'POST', source, error: 'invalid_signature'
			});
			return json({ error: 'Invalid webhook signature' }, { status: 401 });
		}
		// GitHub signs the body only, not the query string. A captured signed push
		// must not authorize an attacker-selected image tag.
		if (githubSignature && event.url.searchParams.has('IMAGE_TAG')) {
			return json({ error: 'IMAGE_TAG requires GitLab token authentication' }, { status: 400 });
		}

		if (refSkip.skip) return skipResponse(refSkip.ref, refSkip.trackedBranch);

		// Deploy the git stack (syncs and deploys only if there are changes)
		const response = await deployWebhook(id, gitStack, url.searchParams.getAll('IMAGE_TAG'));
		await auditGitStack(event, 'webhook', id, gitStack.stackName, gitStack.environmentId, {
			method: 'POST', source, status: response.status
		});
		return response;
	} catch (error: any) {
		console.error('Webhook error:', error);
		return json({ success: false, error: 'Webhook deployment failed' }, { status: 500 });
	}
};

// Also support GET for simple polling/manual triggers
/**
 * @openapi
 * summary: GET webhook trigger for a git stack, with the secret passed as the `secret` query parameter
 * path: id:integer! Git stack ID (from GET /api/git/stacks)
 * query: secret:string Webhook secret; required only if the stack has a webhook secret configured
 * query: IMAGE_TAG:string Docker image tag; an explicit value triggers a deployment and image pull
 * resp-200: {success:boolean, skipped:boolean, error:string, output:string}
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

		const policy = decideWebhookSecretPolicy(!!gitStack.webhookSecret, allowSecretlessWebhook());
		if (policy.action === 'reject-no-secret') {
			await auditGitStack(event, 'webhook', id, gitStack.stackName, gitStack.environmentId, {
				method: 'GET', source: 'get', error: 'no_secret_configured'
			});
			return json({ error: 'Webhook secret is not configured for this stack' }, { status: 401 });
		}
		if (policy.action === 'deploy-unverified') {
			// ALLOW_WEBHOOKS_WITHOUT_SECRET opt-in: deploy without verification, audited.
			const response = await deployWebhook(id, gitStack, url.searchParams.getAll('IMAGE_TAG'));
			await auditGitStack(event, 'webhook', id, gitStack.stackName, gitStack.environmentId, {
				method: 'GET', source: 'get', verification: 'skipped_no_secret', status: response.status
			});
			return response;
		}

		// Verify secret via query parameter for GET requests (constant-time).
		const secret = url.searchParams.get('secret');
		if (!secret || !gitStack.webhookSecret || !timingSafeStringEqual(secret, gitStack.webhookSecret)) {
			await auditGitStack(event, 'webhook', id, gitStack.stackName, gitStack.environmentId, {
				method: 'GET', source: 'get', error: 'invalid_secret'
			});
			return json({ error: 'Invalid webhook secret' }, { status: 401 });
		}

		// Deploy the git stack (syncs and deploys only if there are changes)
		const response = await deployWebhook(id, gitStack, url.searchParams.getAll('IMAGE_TAG'));
		await auditGitStack(event, 'webhook', id, gitStack.stackName, gitStack.environmentId, {
			method: 'GET', source: 'get', status: response.status
		});
		return response;
	} catch (error: any) {
		console.error('Webhook GET error:', error);
		return json({ success: false, error: 'Webhook deployment failed' }, { status: 500 });
	}
};
