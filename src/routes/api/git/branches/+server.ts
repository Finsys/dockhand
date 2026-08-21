import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitRepository, getGitCredential } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { listRemoteBranches } from '$lib/server/git';
import { assertSafeBranchTarget, assertCredentialUrlPair } from '$lib/server/git-branch-lookup';

/**
 * POST /api/git/branches
 * List remote branches for a repository via `git ls-remote`.
 *
 * SECURITY (PR #1343 review): two guards run before any git subprocess.
 *  1. assertSafeBranchTarget — rejects URLs pointing at private / loopback /
 *     link-local addresses (SSRF defense), on BOTH the `url` and
 *     `repositoryId` paths.
 *  2. assertCredentialUrlPair — a raw `url` may only be paired with a stored
 *     `credentialId` when the credential is plausibly for that host
 *     (credential-exfiltration defense). SSH credentials are always allowed.
 * The `ls-remote` itself is bounded by a hard timeout (see execGit).
 *
 * Body: {
 *   repositoryId?: number,     // Existing repository (uses its url + credential)
 *   url?: string,              // OR a new repository URL
 *   credentialId?: number|null // Credential for the url (new-repo flow)
 * }
 *
 * Returns: { branches: string[] }
 */
/**
 * @openapi
 * summary: List remote branches for a git repository via `git ls-remote`
 * description: Accepts either repositoryId (an existing repository, using its stored URL and credential) or url + credentialId (a new repository). SECURITY: the URL must not point at a private/loopback/link-local address, and a raw url may only be paired with a stored credentialId that is plausibly for that host (SSH credentials are always allowed). The ls-remote is bounded by a hard timeout.
 * body: {repositoryId:integer, url:string, credentialId:integer}
 * body-example: {"url":"https://github.com/example/repo.git","credentialId":2}
 * resp-200: {branches:array<string>!}
 * resp-200-example: {"branches":["main","develop","feature/test"]}
 * resp-400: The URL points at a private/loopback/link-local address, the credential does not match the URL host, or neither repositoryId nor url was supplied
 * resp-403: Permission denied (requires git:edit)
 * resp-404: The referenced repository does not exist
 * resp-500: Failed to fetch branches (ls-remote error or timeout)
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const body = await request.json();
		const { repositoryId, url, credentialId } = body as {
			repositoryId?: number;
			url?: string;
			credentialId?: number | null;
		};

		let repoUrl: string;
		let credId: number | undefined;

		if (repositoryId) {
			const repo = await getGitRepository(repositoryId);
			if (!repo) {
				return json({ error: 'Repository not found' }, { status: 404 });
			}
			repoUrl = repo.url;
			credId = repo.credentialId ?? undefined;
		} else if (url) {
			repoUrl = url;
			credId = credentialId ?? undefined;
		} else {
			return json({ error: 'repositoryId or url is required' }, { status: 400 });
		}

		// Guard 1 (SSRF): reject private/loopback/link-local targets. Runs on
		// BOTH paths — a stored repository's URL could also point internal.
		try {
			assertSafeBranchTarget(repoUrl);
		} catch (e: any) {
			return json({ error: e.message || 'Invalid repository URL' }, { status: 400 });
		}

		// Guard 2 (credential exfiltration): when a raw url is paired with a
		// stored credential, verify the credential is plausibly for that host.
		// The repositoryId path is safe — the pairing is the user's own stored
		// repository config, not an attacker-chosen url+credential combo.
		if (url && credId != null) {
			const credential = await getGitCredential(credId);
			if (!credential) {
				return json({ error: 'Credential not found' }, { status: 404 });
			}
			try {
				assertCredentialUrlPair(repoUrl, credential);
			} catch (e: any) {
				return json({ error: e.message || 'Invalid repository URL' }, { status: 400 });
			}
		}

		const result = await listRemoteBranches({ url: repoUrl, credentialId: credId });

		if (result.error) {
			return json({ error: 'Failed to fetch branches: ' + result.error }, { status: 500 });
		}

		return json({ branches: result.branches });
	} catch (error: any) {
		console.error('Failed to fetch branches:', error);
		return json({ error: 'Failed to fetch branches' }, { status: 500 });
	}
};
