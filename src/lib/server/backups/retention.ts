/**
 * backups/retention.ts — pure retention planning.
 *
 * Retention decides which snapshots restic keeps and which it forgets. Two
 * safety properties matter and both live here as pure functions:
 *
 *  1. SAFE DEFAULT: retention is OFF unless explicitly configured. A brand-new
 *     backup config keeps every snapshot forever until the user opts in, so a
 *     misconfiguration can never silently start deleting backups.
 *
 *  2. NEVER WIPE EVERYTHING: before a real prune, restic is run once with
 *     `--dry-run` and the plan is parsed. If the configured policy would delete
 *     EVERY snapshot in the group (keep = 0), the prune is refused. A policy
 *     that keeps nothing is always a mistake, not an intent.
 *
 * The policy is a discriminated union so contradictory settings are
 * unrepresentable — you cannot ask for "keep last 5" and "keep 6 monthly" at
 * once; you pick one mode.
 */

/**
 * Retention policy. `none` is the safe default (keep everything). `keep-last`
 * keeps the N most recent snapshots. `time` keeps the most recent within each
 * time bucket (restic's --keep-daily/weekly/monthly/yearly).
 */
export type RetentionPolicy =
	| { mode: 'none' }
	| { mode: 'keep-last'; last: number }
	| { mode: 'time'; daily?: number; weekly?: number; monthly?: number; yearly?: number };

/** The safe default: keep everything. */
export const NO_RETENTION: RetentionPolicy = { mode: 'none' };

function positiveInt(v: unknown): number | undefined {
	const n = typeof v === 'number' ? v : Number(v);
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Parse a stored retention JSON blob into a RetentionPolicy. The stored shape is
 * `{ keepLast?, keepDaily?, keepWeekly?, keepMonthly?, keepYearly? }` (legacy
 * flat form). Absent / all-zero / unparseable → `none` (the safe default), so a
 * broken config never prunes. `keepLast` takes precedence over time buckets if
 * both are somehow present (the UI only sets one).
 */
export function parseRetention(stored: string | null | undefined | Record<string, unknown>): RetentionPolicy {
	let obj: Record<string, unknown>;
	if (stored == null) return NO_RETENTION;
	if (typeof stored === 'string') {
		if (!stored.trim()) return NO_RETENTION;
		try { obj = JSON.parse(stored); } catch { return NO_RETENTION; }
	} else {
		obj = stored;
	}
	if (!obj || typeof obj !== 'object') return NO_RETENTION;

	const last = positiveInt(obj.keepLast);
	if (last !== undefined) return { mode: 'keep-last', last };

	const daily = positiveInt(obj.keepDaily);
	const weekly = positiveInt(obj.keepWeekly);
	const monthly = positiveInt(obj.keepMonthly);
	const yearly = positiveInt(obj.keepYearly);
	if (daily || weekly || monthly || yearly) {
		return { mode: 'time', daily, weekly, monthly, yearly };
	}
	return NO_RETENTION;
}

/** True if this policy would ever prune anything (i.e. it's not `none`). */
export function retentionActive(policy: RetentionPolicy): boolean {
	return policy.mode !== 'none';
}

/**
 * Build the restic `forget` args for a policy, scoped to a single config's
 * snapshots by tag. Returns null for `none` (nothing to do). The tag filter uses
 * the STABLE per-config identity so no other config's snapshots enter the pool.
 * `--group-by ''` because helper hostnames are random and would otherwise split
 * the group; `--prune` reclaims space; `dryRun` adds `--dry-run` for the wipe check.
 *
 * @param configTagFilter e.g. `dockhand:instance=<uuid>,dockhand:configid=<id>`
 */
export function buildForgetArgs(
	policy: RetentionPolicy,
	configTagFilter: string,
	opts: { dryRun?: boolean; json?: boolean } = {}
): string[] | null {
	if (policy.mode === 'none') return null;

	const args = ['forget'];
	if (opts.json) args.push('--json');
	if (opts.dryRun) args.push('--dry-run');
	else args.push('--prune');
	// `forget` needs an EXCLUSIVE repo lock; --retry-lock is how long it waits for a
	// held lock before giving up. This runs inside Dockhand's per-repo serializer, so
	// no OTHER Dockhand op in THIS instance holds the lock — the only lock that can be
	// present is either (a) an ORPHAN from a backup helper that Dockhand force-removed
	// mid-lock (its hostname is the dead container id, so restic won't age it out as
	// stale for 30min), or (b) a live lock from a SEPARATE Dockhand instance sharing
	// the repo. In both cases a LONG wait is wrong: for (a) we'd block ~10min (5m ×
	// dry-run + 5m × real) on a dead owner — the actual cause of the 300s CI backup
	// timeouts; for (b) a short wait just means retention is skipped this run (prune
	// is non-fatal — the backup already succeeded — and it retries next schedule).
	// So keep it short. A failed/timed-out prune becomes a WARNING, never fails the
	// backup, and never touches another instance's lock. Overridable for slow links.
	const retryLock = process.env.RESTIC_FORGET_RETRY_LOCK || '1m';
	args.push('--retry-lock', retryLock, '--group-by', '', '--tag', configTagFilter);

	if (policy.mode === 'keep-last') {
		args.push('--keep-last', String(policy.last));
	} else {
		if (policy.daily) args.push('--keep-daily', String(policy.daily));
		if (policy.weekly) args.push('--keep-weekly', String(policy.weekly));
		if (policy.monthly) args.push('--keep-monthly', String(policy.monthly));
		if (policy.yearly) args.push('--keep-yearly', String(policy.yearly));
	}
	return args;
}

/**
 * Parse a `restic forget --dry-run --json` result to decide whether the prune
 * would delete EVERY snapshot in the group. `restic forget --json` emits an
 * array of group documents each with `keep[]` and `remove[]`.
 */
export interface WipeCheck {
	wouldWipe: boolean;
	keep: number;
	remove: number;
	total: number;
}

export function checkWouldWipe(dryRunStdout: string): WipeCheck {
	const empty: WipeCheck = { wouldWipe: false, keep: 0, remove: 0, total: 0 };
	const trimmed = dryRunStdout.trim();
	if (!trimmed) return empty;
	let parsed: unknown;
	try { parsed = JSON.parse(trimmed); } catch { return empty; }
	if (!Array.isArray(parsed)) return empty;
	let keep = 0;
	let remove = 0;
	for (const group of parsed) {
		if (!group || typeof group !== 'object') continue;
		const g = group as { keep?: unknown[]; remove?: unknown[] };
		if (Array.isArray(g.keep)) keep += g.keep.length;
		if (Array.isArray(g.remove)) remove += g.remove.length;
	}
	const total = keep + remove;
	// A policy that keeps NOTHING while removing everything is always a mistake.
	return { wouldWipe: total > 0 && keep === 0 && remove > 0, keep, remove, total };
}
