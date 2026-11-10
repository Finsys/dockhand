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
	pending: Array<{ containerId: string; hasImageUpdate?: boolean }>,
	liveContainerIds: Iterable<string>
): number {
	const live = liveContainerIds instanceof Set ? liveContainerIds : new Set(liveContainerIds);
	let n = 0;
	for (const row of pending ?? []) {
		if (row?.containerId && live.has(row.containerId) && isImageUpdateRow(row)) n++;
	}
	return n;
}

/**
 * The dashboard "pending updates" count is an IMAGE-update count (the up-arrow tile), so
 * only a row whose digest actually moved counts. A row kept for a newer-version-tag
 * suggestion, a cooldown, or a pinned-but-unapplied digest is NOT an applicable update and
 * must not inflate the tile - otherwise an environment of pinned containers reads as "all
 * out of date". `hasImageUpdate` is absent on rows from before it was stored; treat that
 * as an update so an old row is never silently dropped.
 */
export function isImageUpdateRow(row: { hasImageUpdate?: boolean }): boolean {
	return row.hasImageUpdate !== false;
}

/** The image-update count without live-matching, for a seed before the container list. */
export function countImageUpdates(pending: Array<{ hasImageUpdate?: boolean }>): number {
	let n = 0;
	for (const row of pending ?? []) if (isImageUpdateRow(row)) n++;
	return n;
}

/**
 * A pinned-digest move: the tag's digest advanced but the image pins the old one, so it
 * is reported, never applied. Counted on its OWN tile, separate from the applicable
 * image-update count, because no bulk update can clear it - the fix is an edit to the
 * compose file.
 */
export function isPinnedDigestRow(row: { pinnedToDigest?: boolean; containerId?: string; hasImageUpdate?: boolean }): boolean {
	return row.pinnedToDigest === true;
}

/** Live-matched pinned-digest count (dashboard tile). */
export function countLivePinnedDigest(
	pending: Array<{ containerId: string; pinnedToDigest?: boolean }>,
	liveContainerIds: Iterable<string>
): number {
	const live = liveContainerIds instanceof Set ? liveContainerIds : new Set(liveContainerIds);
	let n = 0;
	for (const row of pending ?? []) {
		if (row?.containerId && live.has(row.containerId) && isPinnedDigestRow(row)) n++;
	}
	return n;
}

/** Pinned-digest count without live-matching, for a seed before the container list. */
export function countPinnedDigest(pending: Array<{ pinnedToDigest?: boolean; containerId?: string; hasImageUpdate?: boolean }>): number {
	let n = 0;
	for (const row of pending ?? []) if (isPinnedDigestRow(row)) n++;
	return n;
}

/**
 * A newer-version-tag (semver) suggestion: a higher version tag than the one running.
 * Advisory and never auto-applied, so it is counted on its OWN tile, separate from the
 * applicable image-update count. Keyed on the stored `newerVersion` blob being present.
 */
export function isNewerVersionRow(row: { newerVersion?: unknown | null; containerId?: string; hasImageUpdate?: boolean }): boolean {
	return row.newerVersion != null;
}

/** Live-matched newer-version count (dashboard tile). */
export function countLiveNewerVersion(
	pending: Array<{ containerId: string; newerVersion?: unknown | null }>,
	liveContainerIds: Iterable<string>
): number {
	const live = liveContainerIds instanceof Set ? liveContainerIds : new Set(liveContainerIds);
	let n = 0;
	for (const row of pending ?? []) {
		if (row?.containerId && live.has(row.containerId) && isNewerVersionRow(row)) n++;
	}
	return n;
}

/** Newer-version count without live-matching, for a seed before the container list. */
export function countNewerVersion(pending: Array<{ newerVersion?: unknown | null; containerId?: string; hasImageUpdate?: boolean }>): number {
	let n = 0;
	for (const row of pending ?? []) if (isNewerVersionRow(row)) n++;
	return n;
}
