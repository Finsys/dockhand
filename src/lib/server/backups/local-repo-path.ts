/**
 * Pure validation for a LOCAL-path backup repository, shared by init/test (which run
 * restic in the Dockhand container) and the backup/restore helper (a sibling container
 * that bind-mounts the repo by its HOST path).
 *
 * The trap this guards (#1506): when Dockhand runs in a container, the "Path" field is
 * the path AS THE DOCKHAND CONTAINER SEES IT. If the user types the HOST path instead
 * (e.g. /opt/backups) while Dockhand only has it bind-mounted at /app/local-backups,
 * `restic init` writes the repo into the container's own ephemeral filesystem (it
 * vanishes on restart) and the helper - which mounts the host path - later finds an
 * empty dir. Both sides "work" in isolation but never agree on one location.
 *
 * A local repo is only usable when its container path is UNDER one of Dockhand's bind
 * mounts, so the same bytes are reachable from the host (where the helper mounts them).
 *
 * No I/O here: callers pass the cached mount table so this stays unit-testable.
 */

export interface ContainerMount {
	source: string; // host path
	destination: string; // container path
}

export type LocalRepoPathVerdict =
	| { ok: true; hostPath: string } // path is under a bind mount; helper mounts hostPath
	| { ok: true; hostPath: null; reason: 'no-mounts' } // bare-metal: container path IS the host path
	| { ok: false; reason: 'not-under-bind'; mountHints: string[] };

function isUnder(child: string, parent: string): boolean {
	return child === parent || child.startsWith(parent.replace(/\/+$/, '') + '/');
}

/**
 * Decide whether a local repo container path is a usable bind-mounted location.
 * - No mounts known (bare metal, or detection not run): allow; the path is already a
 *   host path (there is no container/host split to get wrong).
 * - Mounts known and the path is under one: allow, returning the translated host path.
 * - Mounts known and the path is NOT under any: reject - this is the #1506 host-path
 *   mistake that would write to the container's ephemeral filesystem.
 */
export function classifyLocalRepoPath(
	repoPath: string,
	mounts: ContainerMount[]
): LocalRepoPathVerdict {
	if (!mounts || mounts.length === 0) {
		return { ok: true, hostPath: null, reason: 'no-mounts' };
	}
	// Longest destination first so the most specific mount wins.
	const sorted = [...mounts].sort((a, b) => b.destination.length - a.destination.length);
	for (const m of sorted) {
		if (isUnder(repoPath, m.destination)) {
			const rel = repoPath.slice(m.destination.replace(/\/+$/, '').length);
			return { ok: true, hostPath: m.source.replace(/\/+$/, '') + rel };
		}
	}
	return {
		ok: false,
		reason: 'not-under-bind',
		mountHints: sorted.map((m) => m.destination)
	};
}

/**
 * The init/test decision as a pure function: returns an error string to surface, or
 * null when the repo is fine. `isLocal` is injected (the caller passes isLocalRepo) so
 * both the remote-exemption gate and the local-path verdict are unit-testable without
 * touching the mount cache or the models module.
 * - Remote repo (isLocal false): always null - never reject a working s3/rest/b2/sftp.
 * - Local repo under a bind (or bare metal): null.
 * - Local repo not under any bind: the #1506 host-path error.
 */
export function localRepoIssueFor(
	repository: string,
	isLocal: boolean,
	mounts: ContainerMount[]
): string | null {
	if (!isLocal) return null;
	const verdict = classifyLocalRepoPath(repository, mounts);
	if (verdict.ok) return null;
	return localRepoPathError(repository, verdict.mountHints);
}

/** Human-readable error for a rejected local repo path (surfaced at init/test). */
export function localRepoPathError(repoPath: string, mountHints: string[]): string {
	const hints = mountHints.length
		? ` Use a path under one of Dockhand's bind mounts instead: ${mountHints.join(', ')}.`
		: '';
	return (
		`Local path "${repoPath}" is not inside any of Dockhand's bind mounts, so the ` +
		`repository would be written to the container's own filesystem and lost on restart, ` +
		`and the backup helper on the host would not find it.${hints} ` +
		`Enter the path as Dockhand sees it (the container side of your volume mount), not the host path.`
	);
}
