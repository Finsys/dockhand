import { json, text } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitRepository } from '$lib/server/db';
import { deployFromRepository } from '$lib/server/git';
import { auditGitRepository } from '$lib/server/audit';
import crypto from 'node:crypto';

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
		return crypto.timingSafeEqual(
			Buffer.from(signature),
			Buffer.from(expectedSignature)
		);
	}

	// GitLab uses X-Gitlab-Token which should match exactly
	return signature === secret;
}

function detectSource(request: Request): string {
	if (request.headers.get('x-hub-signature-256')) return 'github';
	if (request.headers.get('x-gitlab-token')) return 'gitlab';
	return 'unknown';
}

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

		// Verify webhook secret if set
		if (repository.webhookSecret) {
			const payload = await request.text();
			const githubSignature = request.headers.get('x-hub-signature-256');
			const gitlabToken = request.headers.get('x-gitlab-token');

			const signature = githubSignature || gitlabToken;

			if (!verifySignature(payload, signature, repository.webhookSecret)) {
				await auditGitRepository(event, 'webhook', id, repository.name, {
					method: 'POST', source, error: 'invalid_signature'
				});
				return json({ error: 'Invalid webhook signature' }, { status: 401 });
			}
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

		// Verify secret via query parameter for GET requests
		const secret = url.searchParams.get('secret');
		if (repository.webhookSecret && secret !== repository.webhookSecret) {
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
