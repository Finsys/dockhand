import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { testRepositoryConfig } from '$lib/server/git';
import { getGitCredential } from '$lib/server/db';
import { assertSafeRepoTarget } from '$lib/server/git-branch-lookup';
import { authorize } from '$lib/server/authorize';

/**
 * POST /api/git/repositories/test
 * Test a git repository configuration before saving.
 * Uses stored credentials via credentialId.
 *
 * Body: {
 *   url: string;           // Repository URL to test
 *   branch: string;        // Branch name to verify
 *   credentialId?: number; // Optional credential ID from database
 * }
 */
/**
 * @openapi
 * summary: Test an unsaved repository configuration (url/branch/credentialId) before creating it
 * description: credentialId from GET /api/git/credentials. SECURITY: the repository target is checked against the shared SSRF policy — loopback, link-local/cloud-metadata and other reserved dangerous targets are rejected, while ordinary private-LAN addresses are intentionally allowed so self-hosted Git servers remain supported. The ext::/file:: transports and local paths are rejected.
 * body: {url:string!, branch:string, credentialId:integer}
 * body-example: {"url":"https://github.com/example/homelab.git","branch":"main","credentialId":2}
 * resp-200: {success:boolean!, error:string}
 * resp-200-example: {"success":true}
 * resp-400: The url field is missing, the URL points at a loopback/link-local/metadata/reserved target, the URL is an unsupported transport.
 * resp-403: Caller lacks the settings:manage permission
 * resp-404: The referenced credential does not exist
 * resp-500: The connectivity test failed
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('settings', 'manage')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const body = await request.json();

		if (!body.url || typeof body.url !== 'string') {
			return json({ error: 'Repository URL is required' }, { status: 400 });
		}

		// Security: the test endpoint spawns git
		// (ls-remote + clone) with a USER-SUPPLIED url + credentialId. Run the
		// shared guards BEFORE testRepositoryConfig spawns anything.
		//  1. assertSafeRepoTarget — SSRF + transport denylist.
		try {
			assertSafeRepoTarget(body.url);
		} catch (e: any) {
			return json({ success: false, error: e.message || 'Invalid repository URL' }, { status: 400 });
		}
		if (body.credentialId != null && body.credentialId !== undefined) {
			const credential = await getGitCredential(body.credentialId);
			if (!credential) {
				return json({ success: false, error: 'Credential not found' }, { status: 404 });
			}
		}

		const result = await testRepositoryConfig({
			url: body.url,
			branch: body.branch || 'main',
			credentialId: body.credentialId ?? null
		});

		return json(result);
	} catch (error) {
		console.error('Failed to test repository:', error);
		return json({ success: false, error: 'Failed to test repository' }, { status: 500 });
	}
};
