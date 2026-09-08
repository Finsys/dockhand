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

export type HistoryState = 'empty' | 'never-deployed' | 'in-sync' | 'undeployed';

export interface HistoryStatus {
	state: HistoryState;
	/**
	 * The newest saved version whose timestamp <= lastDeployedAt (the live/deployed
	 * one), or null when there is no such version (never deployed, or every saved
	 * version post-dates the last deploy).
	 */
	deployedVersionId: string | null;
	/** Number of versions saved strictly after lastDeployedAt. */
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
 * @param versions  Bounded version refs (newest-first, as returned by the S04 API).
 * @param lastSavedAt  Most recent save time. Accepted for API-shape parity; the
 *   indicator keys off `versions` + `lastDeployedAt`, so this is intentionally
 *   unused (the newest version's timestamp already carries the latest save time).
 * @param lastDeployedAt  Most recent deploy time (null = never deployed).
 */
export function historyStatus(
	versions: StackVersionRef[],
	lastSavedAt: string | null,
	lastDeployedAt: string | null
): HistoryStatus {
	// Accepted for API-shape parity (the panel passes the S04 field through); the
	// status is derived from the version list + lastDeployedAt, not lastSavedAt.
	void lastSavedAt;

	if (versions.length === 0) {
		return { state: 'empty', deployedVersionId: null, undeployedCount: 0 };
	}

	const deployedTime = toTime(lastDeployedAt);
	if (deployedTime === null) {
		// Never deployed: every saved version is undeployed.
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

	return { state: undeployedCount === 0 ? 'in-sync' : 'undeployed', deployedVersionId, undeployedCount };
}
