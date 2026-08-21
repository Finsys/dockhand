import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitRepository, getGitCredential } from '$lib/server/db';
import { previewRepoEnvFiles } from '$lib/server/git';
import { assertSafeRepoTarget, assertCredentialHostMatch } from '$lib/server/git-branch-lookup';
import { authorize } from '$lib/server/authorize';

/**
 * POST /api/git/preview-env
 * Clone a git repository to a temp directory and read env files for preview.
 * Used when creating a new git stack to populate the env editor.
 *
 * Body: {
 *   repositoryId?: number,           // Existing repository
 *   url?: string,                    // OR new repo URL
 *   branch?: string,                 // Branch (default: main)
 *   credentialId?: number,           // Credential for auth
 *   composePath: string,             // Path to compose file
 *   envFilePath?: string             // Optional additional env file
 * }
 *
 * Returns: {
 *   vars: Record<string, string>,    // Merged env variables
 *   sources: {                       // Which file each var came from
 *     [key: string]: '.env' | 'envFile'
 *   },
 *   error?: string
 * }
 */
/**
 * @openapi
 * summary: Clone a repo to a temp dir and preview its merged env-file variables for the git-stack env editor
 * description: repositoryId from GET /api/git/repositories. credentialId from GET /api/git/credentials. SECURITY: the URL host must not be a private/loopback/link-local/metadata address (SSRF), the ext::/file:: transports are rejected, the raw url may only be paired with a stored credentialId whose username plausibly matches that host (exfiltration defense), and composePath/envFilePath are constrained to stay inside the cloned repo (path traversal).
 * body: {repositoryId:integer, url:string, branch:string, credentialId:integer, composePath:string!, envFilePath:string}
 * body-example: {"repositoryId":3,"composePath":"docker-compose.yml","envFilePath":".env.prod"}
 * resp-200: {vars:object!, sources:object!}
 * resp-400: composePath missing, neither repositoryId nor url supplied, the URL points at a private/loopback/link-local/metadata address, the URL is an unsupported transport, the credential does not match the URL host, the compose/env path escapes the repository, or the repo/env-file preview reported an error
 * resp-401: Authentication required
 * resp-404: The referenced repository does not exist
 * resp-500: Failed to preview the env files (clone or read error)
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);

	// Basic permission check - must be able to create stacks
	if (auth.authEnabled && !auth.isAuthenticated) {
		return json({ error: 'Authentication required' }, { status: 401 });
	}

	try {
		const data = await request.json();

		if (!data.composePath || typeof data.composePath !== 'string') {
			return json({ error: 'Compose path is required' }, { status: 400 });
		}

		let repoUrl: string;
		let branch: string = 'main';
		let credentialId: number | null = null;

		if (data.repositoryId) {
			// Use existing repository
			const repo = await getGitRepository(data.repositoryId);
			if (!repo) {
				return json({ error: 'Repository not found' }, { status: 404 });
			}
			repoUrl = repo.url;
			// An explicit branch (e.g. a per-stack override being previewed) wins
			// over the repository default.
			branch = typeof data.branch === 'string' && data.branch.trim() ? data.branch.trim() : repo.branch;
			credentialId = repo.credentialId;
		} else if (data.url) {
			// New repository details
			repoUrl = data.url;
			branch = data.branch || 'main';
			credentialId = data.credentialId || null;
		} else {
			return json({ error: 'Either repositoryId or url is required' }, { status: 400 });
		}

		// Get credential if specified
		let credential = null;
		if (credentialId) {
			credential = await getGitCredential(credentialId);
		}

		// Security (PR #1343 maintainer review): the preview endpoint clones a
		// USER-SUPPLIED URL and reads env files from it. Run the shared guards
		// BEFORE previewRepoEnvFiles spawns git / reads files.
		//  1. assertSafeRepoTarget — SSRF + transport denylist.
		try {
			assertSafeRepoTarget(repoUrl);
		} catch (e: any) {
			return json({ error: e.message || 'Invalid repository URL' }, { status: 400 });
		}
		//  2. assertCredentialHostMatch — a raw url may only be paired with a
		//     stored credential plausibly for that host (exfiltration defense).
		//     The repositoryId path is safe (user's own stored config).
		if (data.url && credentialId && credential) {
			try {
				assertCredentialHostMatch(repoUrl, credential);
			} catch (e: any) {
				return json({ error: e.message || 'Invalid repository URL' }, { status: 400 });
			}
		}

		const result = await previewRepoEnvFiles({
			repoUrl,
			branch,
			credential,
			composePath: data.composePath,
			envFilePath: data.envFilePath || null
		});

		if (result.error) {
			return json({ vars: {}, sources: {}, error: result.error }, { status: 400 });
		}

		return json({
			vars: result.vars,
			sources: result.sources
		});
	} catch (error: any) {
		console.error('Failed to preview env files:', error);
		return json({ error: error.message || 'Failed to preview env files' }, { status: 500 });
	}
};
