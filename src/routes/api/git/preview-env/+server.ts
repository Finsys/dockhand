import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitRepository, getGitCredential } from '$lib/server/db';
import { previewRepoEnvFiles } from '$lib/server/git';
import { assertSafeRepoTarget } from '$lib/server/git-branch-lookup';
import { authorize } from '$lib/server/authorize';
import { handlePreviewEnv, type PreviewEnvAuthContext, type PreviewEnvCredential, type PreviewEnvRepository, type PreviewEnvPreviewOptions, type PreviewEnvPreviewResult } from '$lib/server/preview-env-handler';
/**
 * POST /api/git/preview-env
 * Clone a git repository to a temp directory and read env files for preview.
 * Used when creating a new git stack to populate the env editor.
 *
 * SECURITY: the endpoint clones a
 * USER-SUPPLIED URL and reads env files from it, so it is gated on the
 * `git:edit` permission (same model as /api/git/branches) — an authenticated
 * read-only user cannot use it to clone an arbitrary repository. Two guards
 * run BEFORE any git subprocess is spawned / files are read:
 *  1. assertSafeRepoTarget — the shared SSRF policy. Loopback, link-local /
 *     cloud-metadata and other reserved/dangerous targets are rejected, while
 *     ordinary private-LAN addresses are intentionally allowed so self-hosted
 *     Git servers on RFC1918 ranges (10.x / 192.168.x / 172.16-31.x) keep
 *     working. The ext::/file:: transports and local paths are rejected.
 *  2. repoFilePath — composePath/envFilePath are constrained to stay inside
 *     the cloned repository (path traversal).
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
 * description: repositoryId from GET /api/git/repositories. credentialId from GET /api/git/credentials. SECURITY: requires the git:edit permission when authentication is enabled (403 otherwise). The repository target is checked against the shared SSRF policy — loopback, link-local/cloud-metadata and other reserved dangerous targets are rejected, while ordinary private-LAN addresses are intentionally allowed so self-hosted Git servers remain supported. The ext::/file:: transports and local paths are rejected; and composePath/envFilePath are constrained to stay inside the cloned repository (path traversal).
 * body: {repositoryId:integer, url:string, branch:string, credentialId:integer, composePath:string!, envFilePath:string}
 * body-example: {"repositoryId":3,"composePath":"docker-compose.yml","envFilePath":".env.prod"}
 * resp-200: {vars:object!, sources:object!}
 * resp-400: composePath missing, neither repositoryId nor url supplied, the URL points at a loopback/link-local/metadata/reserved target, the URL is an unsupported transport (ext::/file::), the compose/env path escapes the repository, or the repo/env-file preview reported an error
 * resp-403: Permission denied (requires the git:edit permission — same model as /api/git/branches; an unauthenticated or read-only user is denied here rather than via a separate 401)
 * resp-404: The referenced repository does not exist
 * resp-500: Failed to preview the env files (clone or read error)
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	// Thin SvelteKit route wrapper. Resolves the real dependencies and calls
	// the import-light, dependency-injected handler core
	// (src/lib/server/preview-env-handler.ts), which runs the EXACT production
	// pipeline: the `git:edit` permission gate, body parsing, the SSRF
	// guard, and the env-file preview. This route performs the HTTP/status
	// mapping so the OpenAPI generator (which statically scans the handler
	// body) sees all status codes.
	const deps = {
		// authorize() returns the full auth context (authEnabled, can, …).
		authorize: async (_cookies: unknown) => {
			const auth = await authorize(cookies);
			return auth as PreviewEnvAuthContext;
		},
		getGitRepository: async (id: number) => getGitRepository(id) as Promise<PreviewEnvRepository | null>,
		getGitCredential: async (id: number) => getGitCredential(id) as Promise<PreviewEnvCredential | null>,
		previewRepoEnvFiles: async (opts: PreviewEnvPreviewOptions) =>
			previewRepoEnvFiles(opts) as Promise<PreviewEnvPreviewResult>,
		assertSafeRepoTarget
	};
	const outcome = await handlePreviewEnv(deps, { request, cookies });

	switch (outcome.kind) {
		case 'success':
			return json({ vars: outcome.vars, sources: outcome.sources });
		case 'permission-denied':
			return json({ error: 'Permission denied' }, { status: 403 });
		case 'bad-request': {
			const body: Record<string, unknown> = { error: outcome.message };
			if (outcome.vars) body.vars = outcome.vars;
			if (outcome.sources) body.sources = outcome.sources;
			return json(body, { status: 400 });
		}
		case 'not-found':
			return json({ error: 'Repository not found' }, { status: 404 });
		case 'error':
			return json({ error: outcome.message }, { status: 500 });
	}
};
