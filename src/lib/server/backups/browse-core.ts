/**
 * backups/browse-core.ts — pure parsing of `restic ls --json` output for the
 * snapshot browser. No docker, no DB, so it is unit-testable directly.
 */

/** One restic `ls --json` line. restic emits a `snapshot` header then one entry per node.
 * The node discriminator is `message_type: 'node'` in current restic; older restic used
 * `struct_type: 'node'` (now deprecated). We accept EITHER so a restic bump that drops the
 * old field can't silently empty the browser. */
export interface ResticLsNode {
	message_type?: string;
	struct_type?: string;
	path?: string;
	type?: string;
	size?: number;
	[k: string]: unknown;
}

/** True if a parsed restic ls line is a filesystem node (not the `snapshot` header). */
function isResticNode(e: ResticLsNode): boolean {
	return e.message_type === 'node' || e.struct_type === 'node';
}

/** Normalize a path for self-comparison: collapse repeated slashes at the ends,
 * always leading-slash, no trailing slash (root stays "/"). */
function normalizePath(p: string): string {
	const trimmed = p.replace(/^\/+|\/+$/g, '');
	return trimmed ? '/' + trimmed : '/';
}

/**
 * Parse `restic ls --json <snapshot> <path>` stdout into the directory's CHILD
 * nodes.
 *
 * restic emits one JSON object per line: a `snapshot` header, then a `node` for
 * the queried directory ITSELF, then a `node` for each descendant. If the
 * self-node isn't dropped, the browser renders a phantom child named after the
 * directory (e.g. an empty `volumes/` inside `/volumes/`, `bt-vol/` inside
 * `/volumes/bt-vol/`). Keep only nodes whose path is NOT the queried path.
 */
export function parseSnapshotLsEntries(stdout: string, queriedPath: string): ResticLsNode[] {
	const queried = normalizePath(queriedPath);
	const entries: ResticLsNode[] = [];
	for (const line of stdout.split('\n')) {
		const t = line.trim();
		if (!t) continue;
		let e: ResticLsNode;
		try { e = JSON.parse(t); } catch { continue; }
		if (!isResticNode(e)) continue;
		if (normalizePath(e.path ?? '') === queried) continue; // self-node, not a child
		entries.push(e);
	}
	return entries;
}
