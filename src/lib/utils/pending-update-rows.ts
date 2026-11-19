/**
 * What a persisted pending-update row means.
 *
 * A row can record a digest update, a newer-version-tag suggestion, a held update
 * waiting out the minimum image age, or a combination. The distinction that
 * matters: a HELD update must never be offered for a bulk update, because the
 * cooldown is precisely what would block it. A PINNED one is the same shape of
 * answer - the digest moved, but applying it would pull the manifest already running. Pure so both the server aggregation
 * and the client store agree on the rules.
 */

export interface PendingUpdateRow {
	containerId: string;
	hasImageUpdate?: boolean;
	newerVersion?: unknown | null;
	releaseAgeRemainingHours?: number | null;
	pinnedToDigest?: boolean;
}

/** Whether a row is worth persisting at all. */
export function isWorthPersisting(row: {
	hasImageUpdate?: boolean;
	newerVersion?: unknown | null;
	releaseAgeRemainingHours?: number | null;
	pinnedToDigest?: boolean;
}): boolean {
	return !!row.hasImageUpdate || row.newerVersion != null || !!row.releaseAgeRemainingHours
		|| !!row.pinnedToDigest;
}

/** One update-check result, as far as deciding what to persist is concerned. */
export interface CheckResult {
	containerId: string;
	containerName: string;
	imageName: string;
	hasUpdate?: boolean;
	newerVersion?: unknown | null;
	releaseAgeRemainingHours?: number | null;
	pinnedToDigest?: boolean;
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
		pinnedToDigest: boolean;
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
		const pinnedToDigest = !!r.pinnedToDigest;
		// A pinned move is recorded as pinned, NOT as an image update: `hasImageUpdate` is
		// what a bulk update acts on, and pulling the pinned reference returns the manifest
		// already running.
		const hasImageUpdate = !!r.hasUpdate && !pinnedToDigest;
		const releaseAgeRemainingHours = r.releaseAgeRemainingHours ?? null;
		const newerVersion = r.newerVersion ?? null;
		if (!isWorthPersisting({ hasImageUpdate, newerVersion, releaseAgeRemainingHours, pinnedToDigest })) continue;
		out.push({
			containerId: r.containerId,
			containerName: r.containerName,
			imageName: r.imageName,
			options: { hasImageUpdate, newerVersion, releaseAgeRemainingHours, pinnedToDigest }
		});
	}
	return out;
}

/** A row as stored, as far as carrying it over is concerned (`newerVersion` is JSON text). */
export interface StoredPendingRow {
	containerId: string;
	containerName: string;
	currentImage: string;
	hasImageUpdate: boolean;
	newerVersion: string | null;
	releaseAgeRemainingHours: number | null;
	pinnedToDigest: boolean;
}

/**
 * The rows to persist once a check is done, keeping what a failed check could not
 * re-confirm. A container whose registry check errored keeps the digest half of its
 * previous row (update, pin, hold) - a transient registry failure must not erase an
 * update that is already known. Its newer-version half is the fresh one when this
 * check found one, else the previous. Every other container gets exactly `rows`.
 */
export function withPreviousOnError(
	rows: PersistableRow[],
	previous: StoredPendingRow[],
	erroredIds: ReadonlySet<string>
): PersistableRow[] {
	const out = rows.map((r) => ({ ...r, options: { ...r.options } }));
	for (const prev of previous) {
		if (!erroredIds.has(prev.containerId)) continue;
		let previousNewer: unknown = null;
		try { previousNewer = prev.newerVersion ? JSON.parse(prev.newerVersion) : null; } catch { previousNewer = null; }
		const digestHalf = {
			hasImageUpdate: prev.hasImageUpdate,
			releaseAgeRemainingHours: prev.releaseAgeRemainingHours,
			pinnedToDigest: prev.pinnedToDigest
		};
		const fresh = out.find((r) => r.containerId === prev.containerId);
		if (fresh) {
			Object.assign(fresh.options, digestHalf);
			continue;
		}
		const options = { ...digestHalf, newerVersion: previousNewer };
		if (!isWorthPersisting(options)) continue;
		out.push({ containerId: prev.containerId, containerName: prev.containerName, imageName: prev.currentImage, options });
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
	pinnedDigest: Set<string>;
} {
	const rows = data.pendingUpdates ?? [];
	return {
		updatable: rows
			.filter((r) => r.hasImageUpdate)
			.map((r) => ({ containerId: r.containerId, containerName: (r as any).containerName })),
		newerVersions: new Map(
			rows.filter((r) => r.newerVersion).map((r) => [r.containerId, r.newerVersion])
		),
		coolingDown: coolingDown(rows, data.minimumReleaseAgeHours ?? 1),
		// Carried across a reload so the pin indicator survives it; a row that is only
		// pinned never appears in `updatable`, so no bulk update can reach it.
		pinnedDigest: new Set(rows.filter((r) => r.pinnedToDigest).map((r) => r.containerId))
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

/**
 * The two cooldown fields a container detail carries, kept in lockstep: a
 * container is marked waiting ONLY when hours are known for it, so the UI can
 * never draw the clock without the number beside it.
 */
export function containerCooldownFields(
	coolingDownHoursById: Map<string, number>,
	id: string
): { coolingDown: boolean; coolingDownHours: number | undefined } {
	const hours = coolingDownHoursById.get(id);
	return { coolingDown: hours !== undefined, coolingDownHours: hours };
}
