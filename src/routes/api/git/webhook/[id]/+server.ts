import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitRepository, logAuditEvent, type GitRepositoryData } from '$lib/server/db';
import { deployAllStacksForRepository } from '$lib/server/git';
import { auditGitRepository, getAuditContext } from '$lib/server/audit';
import crypto from 'node:crypto';

function timingSafeEqual(a: string, b: string): boolean {
	const aBuf = Buffer.from(a);
	const bBuf = Buffer.from(b);
	if (aBuf.length !== bBuf.length) return false;
	return crypto.timingSafeEqual(aBuf, bBuf);
}

function verifySignature(payload: string, signature: string | null, secret: string): boolean {
	if (!signature) return false;

	// Support both GitHub and GitLab webhook signatures
	// GitHub: sha256=<hash>
	// GitLab: just the token value in X-Gitlab-Token header

	if (signature.startsWith('sha256=')) {
		const expectedSignature = 'sha256=' + crypto
			.createHmac('sha256', secret)
			.update(payload)
			.digest('hex');
		return timingSafeEqual(signature, expectedSignature);
	}

	return timingSafeEqual(signature, secret);
}

function extractChangedFiles(bodyText: string): string[] | null {
	try {
		const body = JSON.parse(bodyText);
		if (!body || typeof body !== 'object') return null;

		const changed = new Set<string>();

		const commits = body.head_commit
			? [body.head_commit, ...(Array.isArray(body.commits) ? body.commits : [])]
			: Array.isArray(body.commits) ? body.commits : [];

		for (const commit of commits) {
			if (Array.isArray(commit.added)) commit.added.forEach((f: string) => changed.add(f));
			if (Array.isArray(commit.modified)) commit.modified.forEach((f: string) => changed.add(f));
			if (Array.isArray(commit.removed)) commit.removed.forEach((f: string) => changed.add(f));
		}

		return changed.size > 0 ? [...changed] : null;
	} catch {
		return null;
	}
}

function detectSource(request: Request): string {
	if (request.headers.get('x-hub-signature-256')) return 'github';
	if (request.headers.get('x-gitlab-token')) return 'gitlab';
	return 'unknown';
}

export const POST: RequestHandler = async (event) => {
	const { params, request } = event;
	let id: number;
	let repository: GitRepositoryData;
	let bodyText: string | null = null;

	try {
		id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid repository ID' }, { status: 400 });
		}

		repository = await getGitRepository(id) as GitRepositoryData;
		if (!repository) {
			return json({ error: 'Repository not found' }, { status: 404 });
		}

		if (!repository.webhookEnabled) {
			return json({ error: 'Webhook is not enabled for this repository' }, { status: 403 });
		}

		const source = detectSource(request);

		// Read body once — used for signature verification, branch check, and file extraction
		bodyText = await request.text();

		// Verify webhook secret if set
		if (repository.webhookSecret) {
			const githubSignature = request.headers.get('x-hub-signature-256');
			const gitlabToken = request.headers.get('x-gitlab-token');
			const signature = githubSignature || gitlabToken;

			if (!verifySignature(bodyText, signature, repository.webhookSecret)) {
				await auditGitRepository(event, 'webhook', id, repository.name, {
					method: 'POST', source, error: 'invalid_signature'
				});
				return json({ error: 'Invalid webhook signature' }, { status: 401 });
			}
		}

		// Check if the push is for the tracked branch
		try {
			const payload = JSON.parse(bodyText);
			if (payload.ref) {
				const expectedRef = `refs/heads/${repository.branch}`;
				if (payload.ref !== expectedRef) {
					return json({ accepted: true, message: `Push was to ${payload.ref}, not ${expectedRef}, ignoring` }, { status: 200 });
				}
			}
		} catch {
			// If body isn't valid JSON, proceed without branch check
		}

		// Extract changed files from the payload for smart filtering
		const changedFiles = extractChangedFiles(bodyText);

		// Capture audit context before returning 202 — event may be disposed after response
		const auditCtx = await getAuditContext(event);

		// Launch deployment in background so we can respond immediately
		deployAllStacksForRepository(id, {
			deployMode: repository.webhookDeployMode,
			delay: repository.webhookDeployDelay,
			changedFiles: changedFiles ?? undefined
		}).then(async (result) => {
			await logAuditEvent({
				userId: auditCtx.userId,
				username: auditCtx.username,
				action: 'webhook',
				entityType: 'git_repository',
				entityId: String(id),
				entityName: repository.name,
				description: `Git repository ${repository.name} webhook`,
				details: {
					method: 'POST', source, result: result.success ? 'deployed' : 'partial',
					stacks: result.results,
					changedFiles: changedFiles?.length ?? 0
				},
				ipAddress: auditCtx.ipAddress,
				userAgent: auditCtx.userAgent
			});
		}).catch((error: any) => {
			console.error('Background webhook deploy failed:', error);
		});

		return json({ accepted: true, message: 'Webhook received, deploying stacks in background' }, { status: 202 });
	} catch (error: any) {
		console.error('Webhook error:', error);
		return json({ error: error.message, success: false }, { status: 500 });
	}
};
