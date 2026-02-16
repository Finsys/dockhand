import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitStack, getStackSource } from '$lib/server/db';
import { syncGitStack, deployGitStack, getGitStackRepoPath } from '$lib/server/git';
import { authorize } from '$lib/server/authorize';
import { syncStackSecrets } from '$lib/server/vault-sync';

export const POST: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);

	// mode parameter: 'git' | 'vault' | 'all' (default)
	const mode = url.searchParams.get('mode') || 'all';
	if (!['git', 'vault', 'all'].includes(mode)) {
		return json({ error: 'Invalid mode. Must be git, vault, or all' }, { status: 400 });
	}

	try {
		const id = parseInt(params.id);
		const gitStack = await getGitStack(id);
		if (!gitStack) {
			return json({ error: 'Git stack not found' }, { status: 404 });
		}

		// Permission check with environment context
		if (auth.authEnabled && !await auth.can('stacks', 'edit', gitStack.environmentId || undefined)) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}

		const logPrefix = `[Sync:${gitStack.stackName}]`;

		// Mode: vault - Only sync Vault secrets
		if (mode === 'vault') {
			console.log(`${logPrefix} Mode: vault-only`);
			const stackDir = await getGitStackRepoPath(id, gitStack.stackName, gitStack.environmentId);
			if (!stackDir) {
				return json({ error: 'Stack directory not found. Sync git first.' }, { status: 404 });
			}
			
			const vaultResult = await syncStackSecrets(gitStack.stackName, stackDir, gitStack.environmentId);
			
			// Auto-deploy if triggerRedeploy secrets changed
			if (vaultResult.success && vaultResult.triggerRedeploySecrets.length > 0) {
				console.log(`${logPrefix} Vault secrets changed (trigger redeploy): ${vaultResult.triggerRedeploySecrets.join(', ')}`);
				const deployResult = await deployGitStack(id, { force: true });
				return json({
					success: true,
					mode: 'vault',
					synced: vaultResult.synced,
					secretsChanged: vaultResult.secretsChanged,
					triggerRedeploySecrets: vaultResult.triggerRedeploySecrets,
					deployed: true,
					deploySuccess: deployResult.success,
					deployOutput: deployResult.output,
					deployError: deployResult.error
				});
			}
			
			return json({
				success: vaultResult.success,
				mode: 'vault',
				synced: vaultResult.synced,
				errors: vaultResult.errors,
				secretsChanged: vaultResult.secretsChanged,
				deployed: false
			});
		}

		// Mode: git or all - Sync Git (with or without Vault)
		const skipVault = mode === 'git';
		console.log(`${logPrefix} Mode: ${mode}, skipVault: ${skipVault}`);
		
		const syncResult = await syncGitStack(id, { skipVault });
		
		// If sync detected changes that require redeploy (e.g., triggerRedeploy secrets changed),
		// automatically deploy the stack
		if (syncResult.success && syncResult.updated) {
			console.log(`${logPrefix} Changes detected (updated=true), triggering auto-deploy...`);
			// Use force: true because syncGitStack already detected changes and saved secrets
			// The deploy's internal sync would see no changes since secrets are already updated in DB
			const deployResult = await deployGitStack(id, { force: true });
			
			// Merge deploy result into sync result
			return json({
				...syncResult,
				mode,
				deployed: true,
				deploySuccess: deployResult.success,
				deployOutput: deployResult.output,
				deployError: deployResult.error
			});
		}
		
		return json({ ...syncResult, mode, deployed: false });
	} catch (error) {
		console.error('Failed to sync git stack:', error);
		return json({ error: 'Failed to sync git stack' }, { status: 500 });
	}
};
