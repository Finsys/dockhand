/**
 * The uid a container's workload actually runs as.
 *
 * `Config.User` is only the user the image or the run command ASKED for. An image
 * that switches user at runtime (su-exec, gosu, an s6/tini entrypoint) leaves it
 * empty, so reading it alone reports root for a container whose application is not
 * running as root at all.
 *
 * `/containers/{id}/top` knows the truth, but its first row is the init process -
 * tini or the entrypoint shell - which legitimately stays root in order to drop
 * privileges. So the answer is the uid of the first process that is NOT that init
 * process.
 */

export interface TopResponse {
	Titles?: string[];
	Processes?: string[][];
}

/**
 * The effective uid of the container's workload, or null when it cannot be told.
 *
 * Returns null rather than guessing: a caller showing "root" because it could not
 * read the table would repeat the bug this exists to fix.
 */
export function effectiveContainerUid(top: TopResponse | null | undefined): string | null {
	const titles = top?.Titles ?? [];
	const rows = top?.Processes ?? [];
	if (!rows.length) return null;

	const uidIndex = titles.findIndex((t) => t.trim().toUpperCase() === 'UID');
	const pidIndex = titles.findIndex((t) => t.trim().toUpperCase() === 'PID');
	if (uidIndex < 0) return null;

	const uidOf = (row: string[]) => (row[uidIndex] ?? '').trim();

	// Skip the init process. Prefer identifying it by pid 1 where the column is
	// present; otherwise fall back to position, since docker lists it first.
	const isInit = (row: string[], i: number) =>
		pidIndex >= 0 ? (row[pidIndex] ?? '').trim() === '1' : i === 0;

	// Docker reports HOST pids, so pid 1 may not appear at all. Treat the first row
	// as the init process only when nothing else identifies one.
	const hasPidOne = pidIndex >= 0 && rows.some((r) => (r[pidIndex] ?? '').trim() === '1');
	for (let i = 0; i < rows.length; i++) {
		if (hasPidOne ? isInit(rows[i], i) : i === 0) continue;
		const uid = uidOf(rows[i]);
		if (uid) return uid;
	}

	// Single-process container: its own uid is the answer.
	return uidOf(rows[0]) || null;
}

/**
 * Every uid a container is running processes under, excluding the init process.
 *
 * A single uid is the simple case. More than one is the case worth not hiding: an
 * application dropped to an unprivileged uid while something beside it stays root
 * is exactly what a reader of a security panel needs to see, and reporting only the
 * application's uid would be a more convincing untruth than the stale `root` this
 * replaces.
 */
export function containerProcessUids(top: TopResponse | null | undefined): string[] {
	const titles = top?.Titles ?? [];
	const rows = top?.Processes ?? [];
	const uidIndex = titles.findIndex((t) => t.trim().toUpperCase() === 'UID');
	if (uidIndex < 0 || !rows.length) return [];

	const pidIndex = titles.findIndex((t) => t.trim().toUpperCase() === 'PID');
	const hasPidOne = pidIndex >= 0 && rows.some((r) => (r[pidIndex] ?? '').trim() === '1');

	const uids: string[] = [];
	for (let i = 0; i < rows.length; i++) {
		const isInit = hasPidOne ? (rows[pidIndex] !== undefined && (rows[i][pidIndex] ?? '').trim() === '1') : i === 0;
		// A single-process container has no init to skip; its own uid is the answer.
		if (isInit && rows.length > 1) continue;
		const uid = (rows[i][uidIndex] ?? '').trim();
		if (uid && !uids.includes(uid)) uids.push(uid);
	}
	return uids;
}

/**
 * What to display as a container's user: the requested value when the image states
 * one, otherwise the uid(s) its processes actually run under.
 *
 * Falls back to `root` only when the process table could not be read - the same
 * answer as before, rather than a guess dressed up as a measurement. A stopped
 * container has no processes, so it reports what the image asked for, which is all
 * that can honestly be said about it.
 */
export function displayContainerUser(
	configUser: string | null | undefined,
	top?: TopResponse | null
): string {
	const requested = (configUser ?? '').trim();
	if (requested) return requested;
	const uids = containerProcessUids(top);
	if (!uids.length) return 'root';
	// Several uids: name them all, so a root process beside the application is visible.
	return `${uids.join(', ')} (effective)`;
}
