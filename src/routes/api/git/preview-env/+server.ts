import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitRepository, getGitCredential, getComposePathsValidationError, normalizeComposePaths } from '$lib/server/db';
import { previewRepoEnvFiles } from '$lib/server/git';
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

		const composePaths = normalizeComposePaths(data.composePath);
		const composePathsError = getComposePathsValidationError(composePaths);
		if (composePathsError) {
			return json({ error: composePathsError }, { status: 400 });
		}

		const envFilePath = typeof data.envFilePath === 'string' && data.envFilePath.trim()
			? normalizeComposePaths(data.envFilePath)[0]
			: null;
		if (envFilePath) {
			const envFilePathError = getComposePathsValidationError([envFilePath], 'env file path');
			if (envFilePathError) {
				return json({ error: envFilePathError }, { status: 400 });
			}
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
			branch = repo.branch;
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

		const result = await previewRepoEnvFiles({
			repoUrl,
			branch,
			credential,
			composePath: composePaths[0],
			envFilePath
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
