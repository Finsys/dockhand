import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitRepository } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { listRemoteBranches } from '$lib/server/git';
import { assertSafeRepoTarget } from '$lib/server/git-branch-lookup';

/**
 * POST /api/git/branches
 * List remote branches for a repository via `git ls-remote`.
 *
 * SECURITY: assertSafeRepoTarget runs before any git subprocess is spawned —
 * the shared SSRF policy (delegated to isSafeNotificationUrl,
 * src/lib/server/url-safety.ts): loopback, link-local / cloud-metadata and
 * other reserved/dangerous targets are rejected, while ordinary private-LAN
 * addresses are INTENTIONALLY ALLOWED so self-hosted Git servers on RFC1918
 * ranges (10.x / 192.168.x / 172.16-31.x) keep working. Runs on BOTH the `url`
 * and `repositoryId` paths (a stored repository's URL could also point internal).
 * The `ls-remote` itself is bounded by a hard timeout (see listRemoteBranches
 * in src/lib/server/git.ts) — clone/pull/fetch stay unbounded.
 *
 * Body: {
 *   repositoryId?: number,     // Existing repository (uses its url + credential)
 *   url?: string,              // OR a new repository URL
 *   credentialId?: number|null // Credential for the url (new-repo flow)
 * }
 *
 * Returns: { branches: { name: string, sha: string }[] }
 */
/**
 * @openapi
 * summary: List remote branches for a git repository via `git ls-remote`
 * description: Accepts either repositoryId (an existing repository, using its stored URL and credential) or url + credentialId (a new repository). Each branch carries its short commit SHA. SECURITY: the repository target is checked against the shared SSRF policy — loopback, link-local/cloud-metadata and other reserved dangerous targets are rejected, while ordinary private-LAN addresses are intentionally allowed so self-hosted Git servers remain supported. The ls-remote is bounded by a hard timeout.
 * body: {repositoryId:integer, url:string, credentialId:integer}
 * body-example: {"url":"https://github.com/example/repo.git","credentialId":2}
 * resp-200: {branches:array<object>!}
 * resp-200-example: {"branches":[{"name":"main","sha":"a1b2c3d"},{"name":"develop","sha":"e4f5a6b"}]}
 * resp-400: The URL points at a loopback/link-local/metadata/reserved target, or neither repositoryId nor url was supplied
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

		// Guard 1 (SSRF): the shared SSRF policy rejects loopback /
		// link-local / cloud-metadata / reserved targets; ordinary
		// private-LAN addresses are intentionally allowed (self-hosted Git).
		// Runs on BOTH paths — a stored repository's URL could also point
		// internal.
		try {
			assertSafeRepoTarget(repoUrl);
		} catch (e: any) {
			return json({ error: e.message || 'Invalid repository URL' }, { status: 400 });
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
