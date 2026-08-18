/**
 * Pure helper for git-backfill snapshot restore — no DB imports, so it is
 * unit-testable without the SvelteKit runtime (drizzle.ts pulls in
 * $app/environment). The repo-level restore must only write keys the promotion
 * actually touched (H4); this computes that exact update set.
 */

export interface RepoSettingSnapshot {
	autoUpdate?: boolean;
	autoUpdateSchedule?: 'daily' | 'weekly' | 'custom' | null;
	autoUpdateCron?: string | null;
	webhookEnabled?: boolean;
	webhookSecret?: string | null;
	/** Target values applyBackfill writes (absent = that side wasn't promoted). */
	apply?: {
		autoUpdate?: boolean;
		autoUpdateSchedule?: 'daily' | 'weekly' | 'custom';
		autoUpdateCron?: string;
		webhookEnabled?: boolean;
		webhookSecret?: string | null;
	};
}

/**
 * Compute the repo-level fields a snapshot restore must write. Only keys the
 * promotion actually touched are included — a schedule-only promotion must not
 * clobber an untouched repo webhook (or vice-versa).
 */
export function repoRestoreUpdates(original: RepoSettingSnapshot): Partial<RepoSettingSnapshot> {
	const updates: Partial<RepoSettingSnapshot> = {};
	if (original.autoUpdate !== undefined) updates.autoUpdate = original.autoUpdate;
	if (original.autoUpdateSchedule !== undefined) updates.autoUpdateSchedule = original.autoUpdateSchedule;
	if (original.autoUpdateCron !== undefined) updates.autoUpdateCron = original.autoUpdateCron;
	if (original.webhookEnabled !== undefined) updates.webhookEnabled = original.webhookEnabled;
	if (original.webhookSecret !== undefined) updates.webhookSecret = original.webhookSecret;
	return updates;
}
