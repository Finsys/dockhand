/**
 * Pure saved-vs-deployed status for a stack's bounded version history (M001 S05).
 *
 * Pure + side-effect-free (no top-level DB / better-sqlite3 imports) so it can be
 * imported by a bun test without triggering the better-sqlite3 seed that a
 * stacks.ts / db.ts import would. Consumed by the History UI to render a
 * saved-vs-deployed indicator over the S04 `/api/stacks/[name]/history` response
 * `{ type, versions:[{id,timestamp}], lastSavedAt, lastDeployedAt }`.
 *
 * The "deployed" / safe version follows D011: the newest saved version whose
 * timestamp is <= `last_deployed_at`. Anything saved strictly after the last
 * deploy is "undeployed".
 */

export interface StackVersionRef {
	id: string;
	/** ISO-8601 timestamp (newest-first as returned by the S04 API). */
	timestamp: string;
}

export type HistoryState = 'empty' | 'never-deployed' | 'in-sync' | 'undeployed' | 'running-unsaved';

export interface HistoryStatus {
	state: HistoryState;
	/**
	 * The newest saved version whose timestamp <= the effective deploy reference
	 * (lastDeployedAt when set, else deployStartedAt), or null when there is no
	 * such version (never deployed, or every saved version post-dates the reference).
	 */
	deployedVersionId: string | null;
	/** Number of versions saved strictly after the effective deploy reference. */
	undeployedCount: number;
}

function toTime(ts: string | null): number | null {
	if (ts === null) return null;
	const t = new Date(ts).getTime();
	return Number.isNaN(t) ? null : t;
}

/**
 * Compute the saved-vs-deployed status for a version list.
 *
 * The effective deploy reference is `lastDeployedAt` when set (the authoritative
 * record of a Dockhand-performed deploy), else `deployStartedAt` — the runtime
 * fallback for stacks deployed OUTSIDE Dockhand (docker CLI, `docker compose up`):
 * the oldest running container's creation time, i.e. when the stack's live content
 * became running. The deployed version is the newest saved version at-or-before
 * that reference.
 *
 * @param versions  Bounded version refs (newest-first, as returned by the S04 API).
 * @param lastSavedAt  Most recent save time. Accepted for API-shape parity; the
 *   indicator keys off `versions` + `lastDeployedAt`, so this is intentionally
 *   unused (the newest version's timestamp already carries the latest save time).
 * @param lastDeployedAt  Most recent deploy time (null = never deployed by Dockhand).
 * @param deployStartedAt  Runtime reference when the stack was deployed outside
 *   Dockhand (oldest running container's creation time; null = not running or
 *   unknown). Used only when `lastDeployedAt` is null. Defaults to null.
 */
export function historyStatus(
	versions: StackVersionRef[],
	lastSavedAt: string | null,
	lastDeployedAt: string | null,
	deployStartedAt: string | null = null
): HistoryStatus {
	// Accepted for API-shape parity (the panel passes the S04 field through); the
	// status is derived from the version list + the effective deploy reference,
	// not lastSavedAt.
	void lastSavedAt;

	if (versions.length === 0) {
		return { state: 'empty', deployedVersionId: null, undeployedCount: 0 };
	}

	// The pointer wins when present; the runtime reference is the external-deploy
	// fallback (read-only inference, no pointer writes).
	const reference = lastDeployedAt ?? deployStartedAt;
	const deployedTime = toTime(reference);
	if (deployedTime === null) {
		// Never deployed (no pointer, not running): every saved version is undeployed.
		return { state: 'never-deployed', deployedVersionId: null, undeployedCount: versions.length };
	}

	let undeployedCount = 0;
	let deployedVersionId: string | null = null;
	let deployedBestTime: number | null = null;

	for (const v of versions) {
		const t = toTime(v.timestamp);
		if (t === null) continue; // unparseable timestamp: skip for comparison
		if (t > deployedTime) {
			undeployedCount++;
			continue;
		}
		// t <= deployedTime: candidate deployed marker (newest = greatest time; on
		// exact ties the first-seen wins, which for a newest-first list is the newer).
		if (deployedBestTime === null || t > deployedBestTime) {
			deployedBestTime = t;
			deployedVersionId = v.id;
		}
	}

	if (deployedVersionId !== null) {
		return { state: undeployedCount === 0 ? 'in-sync' : 'undeployed', deployedVersionId, undeployedCount };
	}

	// No saved version at-or-before the reference. With the runtime reference that
	// means the running content was never saved as a version: running-unsaved.
	// (With the pointer reference this same shape keeps the historical 'undeployed'.)
	const state: HistoryState = lastDeployedAt === null && deployStartedAt !== null ? 'running-unsaved' : 'undeployed';
	return { state, deployedVersionId: null, undeployedCount: versions.length };
}
