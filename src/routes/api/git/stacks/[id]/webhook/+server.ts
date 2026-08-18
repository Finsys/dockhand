import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitStack, type GitStackWithRepo } from '$lib/server/db';
import { triggerGitStackSyncFromWebhook } from '$lib/server/scheduler';
import { deployGitStack } from '$lib/server/git';
import { auditGitStack } from '$lib/server/audit';
import { handleGitWebhookRequest, type GitWebhookHandlerOptions } from '$lib/server/git-webhook-handler';
import { assertNotMigrating } from '$lib/server/git-migration-guard';
import { stackWebhookContract } from '$lib/utils/git-model-routing';
import { Semaphore } from '$lib/server/semaphore';

// Stack-mode synchronous deploys re-clone the repo per sync, so they hold the
// request worker for the full clone+deploy. Cap concurrent in-flight deploys
// so a burst of webhook calls cannot pile up unbounded workers (F7). The
// network hang risk is bounded at the git layer: the stack engine passes a
// 10-minute timeout to every `git clone` it runs (see execGit in git.ts —
// the subprocess is SIGKILLed on timeout, so the slot is genuinely released).
// A full deploy-level Promise.race is deliberately NOT used: it would return a
// false "timed out" to the provider (triggering a duplicate retry) while the
// deploy keeps running, defeating the point of the concurrency cap.
const MAX_STACK_WEBHOOKS = 5;
const stackWebhookSlots = new Semaphore(MAX_STACK_WEBHOOKS);
async function stackDeployTrigger(id: number): Promise<{ success: boolean; error?: string; output?: string; skipped?: boolean }> {
	const run = stackWebhookSlots.tryRun(() => deployGitStack(id, { force: false }));
	if (!run) {
		return { success: false, error: 'Too many concurrent webhook deploys, try again shortly' };
	}
	return run;
}

/**
 * Stack webhook options are chosen by the stack's OWN model via the pure
 * stackWebhookContract:
 * - Stack model: the primary webhook — synchronous deploy (per-stack contract),
 *   no force-redeploy precondition.
 * - Centralized model: deprecated compat shim (webhooks moved to the
 *   repository); only stacks with force redeployment enabled can have their
 *   own webhook, triggered in the background.
 */
function buildOptions(stack: GitStackWithRepo): GitWebhookHandlerOptions<GitStackWithRepo> {
	const contract = stackWebhookContract(stack.engine === 'centralized' ? 'centralized' : 'stack');
	if (contract.requiresForceRedeploy) {
		return {
			load: (id) => getGitStack(id),
			preconditions: (target) => {
				if (!target.forceRedeploy) {
					return { error: 'Force redeployment is not enabled for this stack', status: 403 };
				}
				return null;
			},
			audit: async (event, id, target, meta) => {
				await auditGitStack(event, 'webhook', id, target.stackName, target.environmentId, meta);
			},
			trigger: (id) => triggerGitStackSyncFromWebhook(id),
			invalidIdMessage: 'Invalid stack ID',
			notFoundMessage: 'Stack not found',
			webhookDisabledMessage: 'Webhook is not enabled for this stack',
			secretNotConfiguredMessage: 'Webhook secret is not configured for this stack',
			successMessage: 'Stack sync triggered',
			deprecated: contract.deprecated
		};
	}

	return {
		load: (id) => getGitStack(id),
		audit: async (event, id, target, meta) => {
			await auditGitStack(event, 'webhook', id, target.stackName, target.environmentId, meta);
		},
		trigger: (id) => stackDeployTrigger(id),
		invalidIdMessage: 'Invalid stack ID',
		notFoundMessage: 'Stack not found',
		webhookDisabledMessage: 'Webhook is not enabled for this stack',
		secretNotConfiguredMessage: 'Webhook secret is not configured for this stack',
		successMessage: 'Stack sync triggered',
		synchronous: contract.synchronous
	};
}

/**
 * Stack-level git webhook. See git-webhook-handler.ts for the shared flow.
 */
/**
 * @openapi
 * summary: Webhook trigger (GitHub/GitLab) that deploys a git stack when its signature/token verifies
 * description: Public endpoint authenticated by the stack's webhook secret via `X-Hub-Signature-256` (GitHub) or `X-Gitlab-Token` (GitLab); the raw request body is used for HMAC verification. Stack-model deploys are synchronous: the deploy result is returned with HTTP 200 even on failure/skip (a 5xx would make the provider redeliver a skipped deploy in a loop).
 * path: id:integer! Git stack ID (from GET /api/git/stacks)
 * resp-200: {success:boolean, skipped:boolean, error:string}
 * resp-200-example: {"success":true,"skipped":false}
 * resp-400: The id path segment is not a valid integer
 * resp-401: The webhook signature or token did not verify
 * resp-403: Webhooks are not enabled for this stack
 * resp-404: No git stack exists with that ID
 * resp-500: An unexpected server error occurred (not a failed deploy — that returns 200)
 */
export const POST: RequestHandler = async (event) => {
	try {
		const stack = await getGitStack(parseInt(event.params.id ?? ''));
		if (!stack) {
			return json({ error: 'Stack not found' }, { status: 404 });
		}
		const locked = await assertNotMigrating([stack.id]);
		if (locked) return locked;
		return await handleGitWebhookRequest(event, buildOptions(stack));
	} catch (error: any) {
		console.error('Stack webhook error:', error);
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
 * resp-500: An unexpected server error occurred (not a failed deploy — that returns 200)
 */
export const GET: RequestHandler = async (event) => {
	try {
		const stack = await getGitStack(parseInt(event.params.id ?? ''));
		if (!stack) {
			return json({ error: 'Stack not found' }, { status: 404 });
		}
		const locked = await assertNotMigrating([stack.id]);
		if (locked) return locked;
		return await handleGitWebhookRequest(event, buildOptions(stack));
	} catch (error: any) {
		console.error('Stack webhook GET error:', error);
		return json({ success: false, error: error.message }, { status: 500 });
	}
};
