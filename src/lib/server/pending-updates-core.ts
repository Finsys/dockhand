/**
 * Pure logic to reconcile `pending_container_updates` after a stack redeploy (#1311).
 * No docker/db imports, so it's unit-testable with fakes.
 *
 * A redeploy recreates containers with new ids, orphaning the pending rows (keyed by
 * old id). We clear a row ONLY when the container provably runs the newest local
 * image for its tag — a pull can fail, so every ambiguity KEEPs the row (never hide
 * a real update).
 */

export interface PendingRow {
	containerId: string;
	containerName: string;
	currentImage: string; // image NAME/tag (e.g. "nginx:latest"), not a sha256
}

export interface LiveContainer {
	name: string;
	imageId: string; // sha256 the container RUNS (container.ImageID)
	project?: string; // com.docker.compose.project label
}

/**
 * The `containerId`s to remove after a pulled redeploy of `stackName` (container
 * names are unique per host, so a row maps to at most one live container). The
 * per-row decision is inline below. `latestIdForTag` wraps getImageIdByTag.
 */
export function pendingRowsToClear(
	pending: PendingRow[],
	liveContainers: LiveContainer[],
	latestIdForTag: (tag: string) => string | null,
	stackName: string
): string[] {
	if (!Array.isArray(pending) || pending.length === 0) return [];

	const liveByName = new Map<string, LiveContainer>();
	for (const c of liveContainers ?? []) {
		if (c && c.name) liveByName.set(c.name, c);
	}

	const toClear: string[] = [];
	for (const row of pending) {
		if (!row || !row.containerId) continue;
		const live = liveByName.get(row.containerName);

		if (!live) {
			toClear.push(row.containerId); // orphan: no live container by this name
			continue;
		}
		if (live.project !== stackName) continue; // another stack / standalone — not ours

		const latest = latestIdForTag(row.currentImage);
		if (latest && live.imageId && live.imageId === latest) {
			toClear.push(row.containerId); // running the newest local image → updated
		}
		// else: still old (pull failed / build: / never) or tag unresolvable → keep
	}

	return toClear;
}

/**
 * Count pending rows that still map to a LIVE container (#1006). The dashboard tile
 * used to show the raw row count, but a row is keyed on containerId, so a container
 * recreated/removed OUT-OF-BAND (compose CLI, docker directly, Watchtower, image retag)
 * leaves an orphan row nothing prunes between checks. The containers page already
 * live-matches (a row shows only if its containerId exists), so the tile over-counted
 * and disagreed with the list. Counting only rows whose containerId is a currently
 * live container makes the tile agree with the list — no schema change, and it never
 * hides a real update (a live container with a pending row is still counted).
 */
export function countLivePending(
	pending: Array<{ containerId: string }>,
	liveContainerIds: Iterable<string>
): number {
	const live = liveContainerIds instanceof Set ? liveContainerIds : new Set(liveContainerIds);
	let n = 0;
	for (const row of pending ?? []) {
		if (row?.containerId && live.has(row.containerId)) n++;
	}
	return n;
}
