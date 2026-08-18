/**
 * Idempotent promotion of stack-level scheduled-sync / webhook settings to the
 * repository, mirroring the original 0012 migration semantics (now moved out of
 * the DB migration into a runtime step — see the implementation plan, Phase 8).
 *
 * Only runs inside the enter-centralized transition. It snapshots the original
 * values it mutates so a failed transition can restore them exactly (N4/F8).
 *
 * Split into two phases so the snapshot can be persisted BEFORE any mutation:
 *  - computeBackfillSnapshot(): read-only — captures originals + targets.
 *  - applyBackfill(): writes the recorded promotions (idempotent).
 * A crash between the snapshot persist and the apply (or mid-apply) therefore
 * resumes from the persisted snapshot instead of re-deriving an empty one from
 * already-backfilled rows (F13/N4).
 */

import { getGitRepositories, getGitStacks, updateGitRepository, updateGitStack } from './db';
import type { GitRepositoryData, GitStackWithRepo } from './db';
import { pickScheduleWinner } from './git-schedule-ranking';
import { repoRestoreUpdates, type RepoSettingSnapshot } from '../utils/git-backfill-restore';

export interface ForceRedeploySnapshot {
	[stackId: number]: boolean;
}

export interface BackfillSnapshot {
	/** Original forceRedeploy per stack, before any backfill set it. */
	forceRedeploy: ForceRedeploySnapshot;
	/** Original repo-level settings, before any promotion wrote them. */
	repoSettings: Record<number, RepoSettingSnapshot>;
}

function groupStacksByRepo(stacks: GitStackWithRepo[]): Map<number, GitStackWithRepo[]> {
	const stacksByRepo = new Map<number, GitStackWithRepo[]>();
	for (const stack of stacks) {
		if (stack.repositoryId == null) continue;
		const list = stacksByRepo.get(stack.repositoryId) ?? [];
		list.push(stack);
		stacksByRepo.set(stack.repositoryId, list);
	}
	return stacksByRepo;
}

/**
 * Read-only phase of the enter-centralized backfill. Captures the original
 * forceRedeploy / repo-level values for everything that WILL be promoted, plus
 * the exact target values applyBackfill should write. Mutates NOTHING, so the
 * snapshot can be persisted (and the baseline written) BEFORE any DB mutation —
 * a crash mid-apply then resumes from the same snapshot instead of re-deriving
 * an empty one from already-backfilled rows (F13/N4).
 */
export async function computeBackfillSnapshot(): Promise<BackfillSnapshot> {
	const repos = await getGitRepositories();
	const stacks = await getGitStacks();

	const snapshot: BackfillSnapshot = { forceRedeploy: {}, repoSettings: {} };
	const stacksByRepo = groupStacksByRepo(stacks);

	for (const repo of repos) {
		const repoStacks = stacksByRepo.get(repo.id) ?? [];
		if (repoStacks.length === 0) continue;

		// Backfill force_redeploy on webhook-enabled stacks (record original).
		for (const stack of repoStacks) {
			if (stack.webhookEnabled && !stack.forceRedeploy) {
				if (!(stack.id in snapshot.forceRedeploy)) {
					snapshot.forceRedeploy[stack.id] = stack.forceRedeploy;
				}
			}
		}

		// Schedule promotion: only when the repo has no schedule of its own.
		if (!repo.autoUpdate) {
			const autoStacks = repoStacks.filter((s) => s.autoUpdate);
			if (autoStacks.length > 0) {
				// Most-frequent schedule wins; lowest stack id breaks ties.
				const winner = pickScheduleWinner(autoStacks)!;
				snapshot.repoSettings[repo.id] = {
					autoUpdate: repo.autoUpdate,
					autoUpdateSchedule: repo.autoUpdateSchedule,
					autoUpdateCron: repo.autoUpdateCron,
					apply: {
						autoUpdate: true,
						autoUpdateSchedule: (winner.autoUpdateSchedule as 'custom' | 'daily' | 'weekly') ?? 'daily',
						autoUpdateCron: winner.autoUpdateCron ?? '0 3 * * *'
					}
				};
			}
		}

		// Webhook promotion: only when the repo has no webhook of its own.
		if (!repo.webhookEnabled) {
			const webhookStacks = repoStacks.filter((s) => s.webhookEnabled && s.webhookSecret != null);
			if (webhookStacks.length > 0) {
				// Lowest stack id wins for the secret.
				const winner = [...webhookStacks].sort((a, b) => a.id - b.id)[0];
				const existing = snapshot.repoSettings[repo.id];
				snapshot.repoSettings[repo.id] = {
					...existing,
					webhookEnabled: repo.webhookEnabled,
					webhookSecret: repo.webhookSecret,
					apply: {
						...existing?.apply,
						webhookEnabled: true,
						webhookSecret: winner.webhookSecret
					}
				};
			}
		}
	}

	return snapshot;
}

/**
 * Apply phase: performs the promotions recorded in the snapshot. Idempotent —
 * re-running after a crash mid-apply writes the same target values and sets
 * forceRedeploy=true again (a no-op on already-backfilled rows).
 */
export async function applyBackfill(snapshot: BackfillSnapshot): Promise<void> {
	for (const [stackIdStr] of Object.entries(snapshot.forceRedeploy)) {
		await updateGitStack(Number(stackIdStr), { forceRedeploy: true });
	}

	for (const [repoIdStr, plan] of Object.entries(snapshot.repoSettings)) {
		const repoId = Number(repoIdStr);
		const apply = plan.apply;
		if (!apply) continue;
		const updates: Partial<GitRepositoryData> = {};
		if (apply.autoUpdate !== undefined) updates.autoUpdate = apply.autoUpdate;
		if (apply.autoUpdateSchedule !== undefined) updates.autoUpdateSchedule = apply.autoUpdateSchedule;
		if (apply.autoUpdateCron !== undefined) updates.autoUpdateCron = apply.autoUpdateCron;
		if (apply.webhookEnabled !== undefined) updates.webhookEnabled = apply.webhookEnabled;
		if (apply.webhookSecret !== undefined) updates.webhookSecret = apply.webhookSecret;
		await updateGitRepository(repoId, updates);
	}
}

/**
 * Restore a backfill snapshot exactly (rollback path). Restores forceRedeploy
 * per stack and clears/preserves the promoted repo-level fields.
 *
 * Only the keys that the promotion actually wrote are restored — a schedule-only
 * promotion must not clobber an untouched repo webhook (or vice-versa). The
 * snapshot records exactly the fields the promotion touched, so a missing key
 * means "never promoted, leave it alone".
 */
export async function restoreBackfillSnapshot(snapshot: BackfillSnapshot | null): Promise<void> {
	if (!snapshot) return;

	for (const [stackIdStr, original] of Object.entries(snapshot.forceRedeploy)) {
		const stackId = Number(stackIdStr);
		await updateGitStack(stackId, { forceRedeploy: original });
	}

	for (const [repoIdStr, original] of Object.entries(snapshot.repoSettings)) {
		const repoId = Number(repoIdStr);
		await updateGitRepository(repoId, repoRestoreUpdates(original));
	}
}
