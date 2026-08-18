/**
 * Pure schedule-ranking logic used by the runtime backfill (git-backfill.ts).
 * Extracted into a DB-free module so the 0010 ordering expectations can be
 * unit-tested without a database connection.
 */

export interface GitStackScheduleLike {
	id: number;
	autoUpdateSchedule?: string | null;
	autoUpdateCron?: string | null;
}

/**
 * Frequency rank for a stack's cron (mirrors the original 0010 SQL ordering):
 * sub-hourly > hourly > daily > weekly > other. Higher = more frequent; the
 * most-frequent schedule wins, ties broken by lowest stack id.
 */
export function scheduleFrequencyRank(stack: GitStackScheduleLike): number {
	const cron = stack.autoUpdateCron ?? '';
	// Minute field (before the first space).
	const spaceIdx = cron.indexOf(' ');
	const minuteField = spaceIdx === -1 ? cron : cron.substring(0, spaceIdx);
	if (minuteField.startsWith('*/')) return 6; // sub-hourly (e.g. */5 * * * *)
	if (spaceIdx === -1) return 1;
	// Hour field (between the first and second space) — mirrors the original
	// 0010 SQL's `instr(cron,' ')+1` check.
	const rest = cron.substring(spaceIdx + 1);
	const secondSpaceIdx = rest.indexOf(' ');
	const hourField = secondSpaceIdx === -1 ? rest : rest.substring(0, secondSpaceIdx);
	if (hourField === '*' || hourField.startsWith('*/')) return 5; // hourly
	if (stack.autoUpdateSchedule === 'daily') return 3;
	const lastChar = cron.trim().slice(-1);
	if (lastChar === '*') return 2; // weekly (day-of-week wildcard)
	return 1;
}

/** Pick the winning schedule stack: most frequent first, lowest id tie-break. */
export function pickScheduleWinner(stacks: GitStackScheduleLike[]): GitStackScheduleLike | undefined {
	if (stacks.length === 0) return undefined;
	return [...stacks].sort((a, b) => {
		const rankDiff = scheduleFrequencyRank(b) - scheduleFrequencyRank(a);
		return rankDiff !== 0 ? rankDiff : a.id - b.id;
	})[0];
}
