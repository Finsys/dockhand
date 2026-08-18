/**
 * Pure per-job migration backfill planning — no database.
 *
 * Mirrors the "migrate {2} leaves stack 1 untouched" guarantee at the decision
 * level: forceRedeploy is set only on SELECTED webhook-enabled stacks, and
 * repo-level schedule/webhook promotions are derived only from the stacks being
 * migrated in THIS job (never from unselected siblings). git-stack-migrate.ts
 * loads the repo rows and delegates here.
 */

import { pickScheduleWinner } from '../server/git-schedule-ranking';

export interface MigrationStackLike {
	id: number;
	repositoryId: number;
	autoUpdate?: boolean;
	autoUpdateSchedule?: string | null;
	autoUpdateCron?: string | null;
	webhookEnabled?: boolean;
	webhookSecret?: string | null;
	forceRedeploy: boolean;
}

export interface MigrationRepoLike {
	id: number;
	autoUpdate?: boolean;
	autoUpdateSchedule?: string | null;
	autoUpdateCron?: string | null;
	webhookEnabled?: boolean;
	webhookSecret?: string | null;
}

export interface MigrationRepoPlan {
	autoUpdate?: boolean;
	autoUpdateSchedule?: string | null;
	autoUpdateCron?: string | null;
	webhookEnabled?: boolean;
	webhookSecret?: string | null;
	/** Target values apply writes (absent = that side wasn't promoted). */
	apply?: {
		autoUpdate?: boolean;
		autoUpdateSchedule?: 'daily' | 'weekly' | 'custom';
		autoUpdateCron?: string;
		webhookEnabled?: boolean;
		webhookSecret?: string | null;
	};
}

export interface MigrationPlan {
	/** Original forceRedeploy per selected webhook-enabled stack (target: true). */
	forceRedeploy: Record<number, boolean>;
	/** Repo-level promotions this job will write (originals + targets). */
	repos: Record<number, MigrationRepoPlan>;
}

/**
 * Compute the scoped backfill plan for the stacks being migrated in ONE job.
 * Only the selected stacks contribute, using the same ranking rules as
 * git-backfill.ts among the SELECTED stacks only.
 */
export function computeMigrationPlan(
	stacks: MigrationStackLike[],
	repos: MigrationRepoLike[]
): MigrationPlan {
	const plan: MigrationPlan = { forceRedeploy: {}, repos: {} };
	const byRepo = new Map<number, MigrationStackLike[]>();
	for (const stack of stacks) {
		const list = byRepo.get(stack.repositoryId) ?? [];
		list.push(stack);
		byRepo.set(stack.repositoryId, list);
	}
	for (const [repoIdStr, repoStacks] of byRepo) {
		const repoId = Number(repoIdStr);
		const repo = repos.find((r) => r.id === repoId);
		if (!repo) continue;

		for (const stack of repoStacks) {
			if (stack.webhookEnabled && !stack.forceRedeploy && !(stack.id in plan.forceRedeploy)) {
				plan.forceRedeploy[stack.id] = stack.forceRedeploy;
			}
		}

		// Schedule promotion: only when the repo has no schedule of its own,
		// ranked among the SELECTED stacks only.
		if (!repo.autoUpdate) {
			const autoStacks = repoStacks.filter((s) => s.autoUpdate);
			if (autoStacks.length > 0) {
				const winner = pickScheduleWinner(autoStacks)!;
				const existing = plan.repos[repoId];
				plan.repos[repoId] = {
					...existing,
					autoUpdate: repo.autoUpdate,
					autoUpdateSchedule: repo.autoUpdateSchedule,
					autoUpdateCron: repo.autoUpdateCron,
					apply: {
						...existing?.apply,
						autoUpdate: true,
						autoUpdateSchedule: (winner.autoUpdateSchedule as 'daily' | 'weekly' | 'custom') ?? 'daily',
						autoUpdateCron: winner.autoUpdateCron ?? '0 3 * * *'
					}
				};
			}
		}

		// Webhook promotion: only when the repo has no webhook of its own,
		// lowest selected stack id wins for the secret.
		if (!repo.webhookEnabled) {
			const webhookStacks = repoStacks.filter((s) => s.webhookEnabled && s.webhookSecret != null);
			if (webhookStacks.length > 0) {
				const winner = [...webhookStacks].sort((a, b) => a.id - b.id)[0];
				const existing = plan.repos[repoId];
				plan.repos[repoId] = {
					autoUpdate: existing?.autoUpdate ?? repo.autoUpdate,
					autoUpdateSchedule: existing?.autoUpdateSchedule ?? repo.autoUpdateSchedule,
					autoUpdateCron: existing?.autoUpdateCron ?? repo.autoUpdateCron,
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
	return plan;
}
