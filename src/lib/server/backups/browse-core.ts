/**
 * backups/browse-core.ts — pure parsing of `restic ls --json` output for the
 * snapshot browser. No docker, no DB, so it is unit-testable directly.
 */

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
export function parseSnapshotLsEntries(stdout: string, queriedPath: string): any[] {
	const queried = normalizePath(queriedPath);
	const entries: any[] = [];
	for (const line of stdout.split('\n')) {
		const t = line.trim();
		if (!t) continue;
		let e: any;
		try { e = JSON.parse(t); } catch { continue; }
		if (e?.struct_type !== 'node') continue;
		if (normalizePath(e.path ?? '') === queried) continue; // self-node, not a child
		entries.push(e);
	}
	return entries;
}
