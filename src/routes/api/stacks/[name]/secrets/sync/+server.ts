/**
 * Stack Secrets Sync API
 *
 * POST /api/stacks/[name]/secrets/sync - Sync secrets from Vault for a stack
 */

import { json, type RequestHandler } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import { syncStackSecrets } from '$lib/server/vault-sync';
import { findStackDir } from '$lib/server/stacks';
import { getStackSource } from '$lib/server/db';
import { getGitStackRepoPath } from '$lib/server/git';

/**
 * POST /api/stacks/[name]/secrets/sync
 * Sync secrets from Vault for a specific stack
 */
export const POST: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : null;

	// Permission check
	if (auth.authEnabled && !await auth.can('stacks', 'edit', envIdNum ?? undefined)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !await auth.canAccessEnvironment(envIdNum)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	try {
		const stackName = decodeURIComponent(params.name!);

		// Check if this is a git stack
		const source = await getStackSource(stackName, envIdNum);
		let stackDir: string | null = null;

		if (source?.sourceType === 'git' && source.gitStackId) {
			// Git stack: use git repo path
			stackDir = await getGitStackRepoPath(source.gitStackId, stackName, envIdNum);
		} else {
			// Regular stack: use stacks directory
			stackDir = await findStackDir(stackName, envIdNum);
		}

		if (!stackDir) {
			return json({ error: 'Stack directory not found' }, { status: 404 });
		}

		// Sync secrets
		const result = await syncStackSecrets(stackName, stackDir, envIdNum);

		if (result.skipped) {
			return json({
				success: true,
				message: 'No .secrets.yaml file found in stack directory',
				synced: 0
			});
		}

		if (!result.success) {
			return json({
				success: false,
				message: 'Failed to sync some secrets',
				synced: result.synced,
				errors: result.errors
			}, { status: result.synced > 0 ? 200 : 500 });
		}

		return json({
			success: true,
			message: `Successfully synced ${result.synced} secret(s) from Vault`,
			synced: result.synced
		});
	} catch (error) {
		console.error('Failed to sync stack secrets:', error);
		return json({
			success: false,
			error: error instanceof Error ? error.message : 'Failed to sync secrets'
		}, { status: 500 });
	}
};
