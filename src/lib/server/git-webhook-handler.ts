import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { verifyWebhookSignature } from './webhook-signature';

/**
 * Reject oversized payloads before buffering the body. These endpoints are
 * unauthenticated (HMAC-authenticated), so an attacker could otherwise OOM
 * the process with multi-GB bodies. Real webhook payloads (GitHub, GitLab,
 * Gitea) are a few hundred KB at most.
 */
const MAX_WEBHOOK_BODY_BYTES = 5 * 1024 * 1024;

function detectSource(request: Request): string {
	if (request.headers.get('x-hub-signature-256')) return 'github';
	if (request.headers.get('x-gitlab-token')) return 'gitlab';
	return 'unknown';
}

function bodyTooLarge(request: Request): boolean {
	const contentLength = Number(request.headers.get('content-length') ?? 0);
	return Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BODY_BYTES;
}

/** True when the request omits Content-Length entirely (cannot pre-cap the body). */
function missingContentLength(request: Request): boolean {
	return request.headers.get('content-length') === null;
}

export interface GitWebhookEntity {
	webhookEnabled: boolean | null;
	webhookSecret: string | null;
}

export interface GitWebhookAuditMeta {
	method: 'GET' | 'POST';
	source: string;
	error?: string;
	result?: string;
}

export interface GitWebhookHandlerOptions<TEntity extends GitWebhookEntity> {
	load: (id: number) => Promise<TEntity | null>;
	/** Extra gates run before the shared webhook-enabled check, in order. */
	preconditions?: (entity: TEntity) => { error: string; status: number } | null;
	audit: (event: RequestEvent, id: number, entity: TEntity, meta: GitWebhookAuditMeta) => Promise<void>;
	trigger: (id: number) => Promise<{ success: boolean; error?: string }>;
	invalidIdMessage: string;
	notFoundMessage: string;
	webhookDisabledMessage: string;
	secretNotConfiguredMessage: string;
	successMessage: string;
	deprecated?: boolean;
	/**
	 * When true the trigger is awaited and its result body is returned directly
	 * (HEAD~1 stack-webhook contract: `{success, output, error, skipped}`).
	 * When false (default) the trigger is expected to be non-blocking and a 202
	 * is returned. Auth (signature headers, body cap) is identical in
	 * both modes (F6/F7).
	 */
	synchronous?: boolean;
}

/**
 * Post-trigger audit + response, shared by GET and POST.
 *
 * Synchronous triggers (stack-mode webhook) ran the deploy inline, so the body
 * IS the result and 200 is returned even on failure/skip: a 5xx would make
 * GitHub/GitLab treat the delivery as failed and redeliver — a deploy that
 * merely skipped (image upgrade, no config change) would redeliver in a loop.
 * The audit keeps the old skipped/deployed/failed distinction.
 *
 * Background triggers keep 5xx on failure so a genuinely failed dispatch is
 * retried, and are audited as triggered/failed.
 */
async function finishWebhookTrigger<TEntity extends GitWebhookEntity>(
	event: RequestEvent,
	id: number,
	entity: TEntity,
	options: GitWebhookHandlerOptions<TEntity>,
	result: { success: boolean; error?: string; skipped?: boolean },
	method: 'GET' | 'POST',
	source: string
): Promise<Response> {
	if (options.synchronous) {
		await options.audit(event, id, entity, {
			method, source, result: result.skipped ? 'skipped' : result.success ? 'deployed' : 'failed'
		});
		return json(result);
	}

	await options.audit(event, id, entity, {
		method, source, result: result.success ? 'triggered' : 'failed'
	});
	if (!result.success) {
		return json(result, { status: 500 });
	}
	return json({
		success: true,
		message: options.successMessage,
		...(options.deprecated ? { deprecated: true } : {})
	}, { status: 202 });
}

/**
 * Shared git webhook request flow for repository and stack webhook endpoints.
 *
 * POST: verifies the provider signature (X-Hub-Signature-256 or
 * X-Gitlab-Token) over the raw body.
 * GET: verifies the webhook secret passed as the ?secret= query parameter.
 * Both trigger the configured sync in the background and return 202.
 */
export async function handleGitWebhookRequest<TEntity extends GitWebhookEntity>(
	event: RequestEvent,
	options: GitWebhookHandlerOptions<TEntity>
): Promise<Response> {
	const { params, request, url } = event;

	const id = parseInt(params.id ?? '');
	if (isNaN(id)) {
		return json({ error: options.invalidIdMessage }, { status: 400 });
	}

	const entity = await options.load(id);
	if (!entity) {
		return json({ error: options.notFoundMessage }, { status: 404 });
	}

	const precondition = options.preconditions?.(entity) ?? null;
	if (precondition) {
		return json({ error: precondition.error }, { status: precondition.status });
	}

	if (!entity.webhookEnabled) {
		return json({ error: options.webhookDisabledMessage }, { status: 403 });
	}

	if (request.method === 'GET') {
		// A secret is mandatory: reject if none is configured.
		if (!entity.webhookSecret) {
			await options.audit(event, id, entity, {
				method: 'GET', source: 'get', error: 'no_secret_configured'
			});
			return json({ error: options.secretNotConfiguredMessage }, { status: 401 });
		}

		// Verify secret via query parameter for GET requests.
		const secret = url.searchParams.get('secret');
		if (secret !== entity.webhookSecret) {
			await options.audit(event, id, entity, {
				method: 'GET', source: 'get', error: 'invalid_secret'
			});
			return json({ error: 'Invalid webhook secret' }, { status: 401 });
		}

		// Run the trigger (synchronous deploys return their full result; background
		// syncs are dispatched and return 202).
		const result = await options.trigger(id);
		return finishWebhookTrigger(event, id, entity, options, result, 'GET', 'get');
	}

	const source = detectSource(request);

	// A secret is mandatory: reject if none is configured.
	if (!entity.webhookSecret) {
		await options.audit(event, id, entity, {
			method: 'POST', source, error: 'no_secret_configured'
		});
		return json({ error: options.secretNotConfiguredMessage }, { status: 401 });
	}

	// Reject before reading the body when no signature header is present.
	const githubSignature = request.headers.get('x-hub-signature-256');
	const gitlabToken = request.headers.get('x-gitlab-token');
	if (!githubSignature && !gitlabToken) {
		await options.audit(event, id, entity, {
			method: 'POST', source, error: 'missing_signature'
		});
		return json({ error: 'Invalid webhook signature' }, { status: 401 });
	}

	// Reject oversized payloads before buffering them.
	if (bodyTooLarge(request)) {
		await options.audit(event, id, entity, {
			method: 'POST', source, error: 'payload_too_large'
		});
		return json({ error: 'Webhook payload too large' }, { status: 413 });
	}

	// A missing Content-Length means the body cannot be size-capped before
	// request.text() buffers it (these routes are HMAC-only, so an attacker
	// could otherwise OOM the process with a multi-GB body). Real providers
	// (GitHub/GitLab/Gitea/Forgejo) always send Content-Length on webhook POSTs.
	if (missingContentLength(request)) {
		await options.audit(event, id, entity, {
			method: 'POST', source, error: 'missing_content_length'
		});
		return json({ error: 'Webhook request must include a Content-Length header' }, { status: 411 });
	}

	const payload = await request.text();
	if (payload.length > MAX_WEBHOOK_BODY_BYTES) {
		await options.audit(event, id, entity, {
			method: 'POST', source, error: 'payload_too_large'
		});
		return json({ error: 'Webhook payload too large' }, { status: 413 });
	}

	const signature = githubSignature || gitlabToken;

	if (!verifyWebhookSignature(payload, signature, entity.webhookSecret)) {
		await options.audit(event, id, entity, {
			method: 'POST', source, error: 'invalid_signature'
		});
		return json({ error: 'Invalid webhook signature' }, { status: 401 });
	}

	// Run the trigger (synchronous deploys return their full result; background
	// syncs are dispatched and return 202).
	const result = await options.trigger(id);
	return finishWebhookTrigger(event, id, entity, options, result, 'POST', source);
}
