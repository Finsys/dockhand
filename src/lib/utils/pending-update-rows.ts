/**
 * What a persisted pending-update row means.
 *
 * A row can record a digest update, a newer-version-tag suggestion, a held update
 * waiting out the minimum image age, or a combination. The distinction that
 * matters: a HELD update must never be offered for a bulk update, because the
 * cooldown is precisely what would block it. Pure so both the server aggregation
 * and the client store agree on the rules.
 */

export interface PendingUpdateRow {
	containerId: string;
	hasImageUpdate?: boolean;
	newerVersion?: unknown | null;
	releaseAgeRemainingHours?: number | null;
}

/** Whether a row is worth persisting at all. */
export function isWorthPersisting(row: {
	hasImageUpdate?: boolean;
	newerVersion?: unknown | null;
	releaseAgeRemainingHours?: number | null;
}): boolean {
	return !!row.hasImageUpdate || row.newerVersion != null || !!row.releaseAgeRemainingHours;
}

/** One update-check result, as far as deciding what to persist is concerned. */
export interface CheckResult {
	containerId: string;
	containerName: string;
	imageName: string;
	hasUpdate?: boolean;
	newerVersion?: unknown | null;
	releaseAgeRemainingHours?: number | null;
	systemContainer?: unknown;
	updateDisabled?: boolean;
}

/** What a check result becomes in the pending-updates table. */
export interface PersistableRow {
	containerId: string;
	containerName: string;
	imageName: string;
	options: {
		hasImageUpdate: boolean;
		newerVersion: unknown | null;
		releaseAgeRemainingHours: number | null;
	};
}

/**
 * The rows a finished check should persist.
 *
 * A held update is kept with `hasImageUpdate` false and its hours, so the UI can
 * show it as waiting without any bulk update ever offering it. System and
 * update-disabled containers are never recorded.
 */
export function rowsToPersist(results: CheckResult[]): PersistableRow[] {
	const out: PersistableRow[] = [];
	for (const r of results) {
		if (r.systemContainer || r.updateDisabled) continue;
		const hasImageUpdate = !!r.hasUpdate;
		const releaseAgeRemainingHours = r.releaseAgeRemainingHours ?? null;
		const newerVersion = r.newerVersion ?? null;
		if (!isWorthPersisting({ hasImageUpdate, newerVersion, releaseAgeRemainingHours })) continue;
		out.push({
			containerId: r.containerId,
			containerName: r.containerName,
			imageName: r.imageName,
			options: { hasImageUpdate, newerVersion, releaseAgeRemainingHours }
		});
	}
	return out;
}

/** The pending-updates response, as far as the client store is concerned. */
export interface PendingUpdatesResponse {
	pendingUpdates?: PendingUpdateRow[] & { containerName?: string }[];
	/** The cooldown in force now. Absent on a server that predates it. */
	minimumReleaseAgeHours?: number;
}

/**
 * Split a pending-updates response into the three things the UI shows.
 *
 * The cooldown hours come from the RESPONSE, not from the rows: rows outlive the
 * setting, so a cooldown turned off has to stop counting before the next check
 * rewrites them. A server that does not report the setting is treated as having
 * one, which keeps a stored row visible rather than silently dropping it.
 */
export function splitPendingUpdates(data: PendingUpdatesResponse): {
	updatable: { containerId: string; containerName: string }[];
	newerVersions: Map<string, unknown>;
	coolingDown: Map<string, number>;
} {
	const rows = data.pendingUpdates ?? [];
	return {
		updatable: rows
			.filter((r) => r.hasImageUpdate)
			.map((r) => ({ containerId: r.containerId, containerName: (r as any).containerName })),
		newerVersions: new Map(
			rows.filter((r) => r.newerVersion).map((r) => [r.containerId, r.newerVersion])
		),
		coolingDown: coolingDown(rows, data.minimumReleaseAgeHours ?? 1)
	};
}

/** Containers that may be updated now - the ones a bulk update should act on. */
export function updatableIds(rows: PendingUpdateRow[]): string[] {
	return rows.filter((r) => r.hasImageUpdate).map((r) => r.containerId);
}

/**
 * Containers whose update is held, as id -> hours left.
 *
 * A row carrying BOTH a digest update and a cooldown is reported as updatable,
 * not held: `hasImageUpdate` is only ever true once the cooldown has elapsed, so
 * treating it as held would hide a ready update behind a stale number.
 *
 * `cooldownHours` is the cooldown in force NOW. Rows outlive the setting - they
 * are only rewritten by the next check - so a cooldown turned off must stop
 * counting immediately rather than leaving stale "waiting" indicators behind.
 */
export function coolingDown(rows: PendingUpdateRow[], cooldownHours = 1): Map<string, number> {
	const out = new Map<string, number>();
	if (!cooldownHours) return out;
	for (const r of rows) {
		if (!r.hasImageUpdate && r.releaseAgeRemainingHours) {
			out.set(r.containerId, r.releaseAgeRemainingHours);
		}
	}
	return out;
}
