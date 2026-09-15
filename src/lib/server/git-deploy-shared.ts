/**
 * Shared post-sync git deploy body.
 *
 * Both engines (stack git-stack.ts, centralized git-centralized.ts) run the
 * same "deploy a stack from a successful sync result" skeleton: decide whether
 * to deploy, run docker compose, finalize the deletion sync, record the stack
 * source, roll back lastCommit on failure, and emit the single git_sync_*
 * notification. Extracted here so a fix to that body (e.g. deploy bugfixes)
 * lands in ONE place instead of two/three near-duplicates.
 *
 * The SYNC half differs per engine (per-stack re-clone vs shared-clone sync),
 * so each engine keeps its own syncGitStack and feeds the resulting SyncResult
 * into this function.
 */

import { join } from 'node:path';
import { updateGitStack, upsertStackSource } from './db';
import { deployStack, getStackDir } from './stacks';
import {
	finalizeDeletionSync,
	notifyGitSync,
	type SyncResult,
	type DeployGitStackResult,
	type ProgressCallback
} from './git';
import { parseComposePathsColumn } from './compose-files';
import { buildSyncChangeSummary, formatChangeTable, skipReasonMessage } from './git-deletions';
import { shouldDeployGitStack, type DeployGitStackOpts } from '../utils/git-deploy-gating';

/** The git stack fields this deploy body reads (structural, so both engines fit). */
export interface GitStackForDeploy {
	stackName: string;
	environmentId: number | null;
	forceRedeploy: boolean;
	buildOnDeploy: boolean;
	noBuildCache: boolean;
	repullImages: boolean;
	composePaths: string | null;
	repositoryId: number;
	lastCommit: string | null;
}

export interface DeployStackFromSyncArgs {
	stackId: number;
	gitStack: GitStackForDeploy;
	opts: DeployGitStackOpts;
	syncResult: SyncResult;
	onProgress?: ProgressCallback;
	logPrefix: string;
}

/**
 * Deploy a stack after its sync succeeded. Returns the deploy result; the
 * git_sync_success/failed/skipped notification is emitted here (deployStack
 * suppressed its stack_* notification via isGitDeploy, so this is the single
 * one). Deploy failures are handled inline (rollback lastCommit, progress
 * error) rather than thrown.
 */
export async function deployStackFromSync(args: DeployStackFromSyncArgs): Promise<DeployGitStackResult> {
	const { stackId, gitStack, opts, syncResult, onProgress, logPrefix } = args;
	const { force, ignoreForceRedeploy } = opts;

	// forceRedeploy setting overrides the skip logic for webhooks/scheduled
	// syncs. For new stacks (first deploy), syncResult.updated will be true.
	const shouldDeploy = shouldDeployGitStack({
		force,
		ignoreForceRedeploy,
		forceRedeploy: gitStack.forceRedeploy,
		updated: syncResult.updated
	});
	if (!shouldDeploy) {
		console.log(`${logPrefix} No changes detected and force=false, forceRedeploy=false, skipping redeploy`);
		const skippedResult = {
			success: true,
			output: 'No changes detected, skipping redeploy',
			skipped: true
		};
		await notifyGitSync(gitStack.stackName, gitStack.environmentId, skippedResult);
		return skippedResult;
	}

	const forceRecreate = syncResult.updated;
	console.log(`${logPrefix} Will force recreate:`, forceRecreate, `(updated=${syncResult.updated})`);
	console.log(`${logPrefix} Build on deploy:`, gitStack.buildOnDeploy);
	console.log(`${logPrefix} Re-pull images:`, gitStack.repullImages);
	console.log(`${logPrefix} Force redeploy setting:`, gitStack.forceRedeploy);

	// Show the git file changes BEFORE the deploy starts, so the user sees what
	// changed while the deploy runs and the deploy start/result lines stay
	// together (#1260). Removals reflect the deletion plan here; apply-stage
	// divergences (rare) are reported after the deploy.
	if (onProgress && syncResult.previousManifest && syncResult.newFiles && syncResult.deletionPlan) {
		const changeTable = formatChangeTable(
			buildSyncChangeSummary(
				syncResult.previousManifest.files,
				syncResult.newFiles,
				{ deleted: syncResult.deletionPlan.toDelete.map((f) => f.path), skipped: [] },
				syncResult.deletionPlan.skipped
			)
		);
		onProgress({ status: 'deploying', message: `File changes: ${changeTable[0]}`, step: 5, totalSteps: 5 });
		for (const line of changeTable.slice(1)) {
			onProgress({ status: 'deploying', message: line, step: 5, totalSteps: 5 });
		}
		onProgress({ status: 'deploying', message: `Deploying ${gitStack.stackName}...`, step: 5, totalSteps: 5 });
		if (syncResult.deletionPlan.toDelete.length > 0) {
			onProgress({
				status: 'deploying',
				message: `Removing ${syncResult.deletionPlan.toDelete.length} file(s) deleted from the repository...`,
				step: 5,
				totalSteps: 5
			});
		}
	}

	console.log(`${logPrefix} Calling deployStack...`);
	console.log(`${logPrefix} Source directory (composeDir):`, syncResult.composeDir);
	console.log(`${logPrefix} Compose filename:`, syncResult.composeFileName);
	console.log(`${logPrefix} Env filename:`, syncResult.envFileName ?? '(none)');

	const result = await deployStack({
		name: gitStack.stackName,
		compose: syncResult.composeContent!,
		envId: gitStack.environmentId,
		sourceDir: syncResult.composeDir, // Copy entire directory from git repo
		composeFileName: syncResult.composeFileName, // Use original compose filename from repo
		envFileName: syncResult.envFileName, // Env file relative to compose dir (for --env-file flag, optional)
		composePaths: gitStack.composePaths ? parseComposePathsColumn(gitStack.composePaths) : undefined,
		forceRecreate,
		build: gitStack.buildOnDeploy,
		noBuildCache: gitStack.noBuildCache,
		pullPolicy: gitStack.repullImages ? 'always' : undefined,
		filesToDelete: syncResult.deletionPlan?.toDelete,
		isGitDeploy: true // suppress stack_* notification; we emit git_sync_* below
	});

	console.log(`${logPrefix} ----------------------------------------`);
	console.log(`${logPrefix} DEPLOY GIT STACK RESULT`);
	console.log(`${logPrefix} ----------------------------------------`);
	console.log(`${logPrefix} Success:`, result.success);
	if (result.output) console.log(`${logPrefix} Output:`, result.output);
	if (result.error) console.log(`${logPrefix} Error:`, result.error);

	if (result.success) {
		// Deletion sync: persist manifest + log per-file change summary
		if (syncResult.previousManifest && syncResult.newFiles && syncResult.newCommitFull && syncResult.deletionPlan) {
			await finalizeDeletionSync({
				stackId,
				logPrefix,
				previousManifest: syncResult.previousManifest,
				newCommitFull: syncResult.newCommitFull,
				newFiles: syncResult.newFiles,
				plan: syncResult.deletionPlan,
				applyResult: result.deletion
			});
		}

		// Record the stack source with resolved compose path for consistency
		const stackDir = await getStackDir(gitStack.stackName, gitStack.environmentId);
		const resolvedComposePath = syncResult.composeFileName
			? join(stackDir, syncResult.composeFileName)
			: undefined;

		console.log(`${logPrefix} Resolved compose path for stack_sources:`, resolvedComposePath);

		await upsertStackSource({
			stackName: gitStack.stackName,
			environmentId: gitStack.environmentId,
			sourceType: 'git',
			gitRepositoryId: gitStack.repositoryId,
			gitStackId: stackId,
			composePath: resolvedComposePath,
			composePaths: gitStack.composePaths ? parseComposePathsColumn(gitStack.composePaths) : null
		});

		if (onProgress) {
			const applySkips = (result.deletion?.skipped ?? []).filter((s) => s.reason !== 'already-absent');
			for (const skip of applySkips) {
				onProgress({
					status: 'deploying',
					message: `Kept "${skip.path}" — ${skipReasonMessage(skip.reason)}`,
					step: 5,
					totalSteps: 5
				});
			}
			onProgress({ status: 'complete', message: `Successfully deployed ${gitStack.stackName}` });
		}
	} else {
		// Sync advanced lastCommit before deploy. Roll it back on deploy failure so
		// the next scheduled/webhook sync still sees the commit as pending and retries.
		if (syncResult.updated && syncResult.commit) {
			console.log(`${logPrefix} Deploy failed after sync — rolling back lastCommit to enable retry`);
			await updateGitStack(stackId, {
				lastCommit: gitStack.lastCommit ?? null,
				syncStatus: 'error',
				syncError: result.error || 'Deploy failed'
			});
		}
		onProgress?.({ status: 'error', error: result.error || 'Failed to deploy stack' });
	}

	await notifyGitSync(gitStack.stackName, gitStack.environmentId, result);
	return result;
}
