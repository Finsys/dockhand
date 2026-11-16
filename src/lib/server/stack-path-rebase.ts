import { resolve } from 'node:path';

// A stored stack path under oldDir moves with the directory to newDir; any other
// path (a custom location outside the env's stacks dir) is left alone.
export function rebaseStackPath(path: string | null, oldDir: string, newDir: string): string | null {
	if (!path) return path;
	const normalized = resolve(path);
	const from = resolve(oldDir);
	if (normalized === from) return newDir;
	if (normalized.startsWith(from + '/')) return newDir + normalized.slice(from.length);
	return path;
}

export function rebaseStackSourceRow(
	row: { composePath: string | null; envPath: string | null },
	oldDir: string,
	newDir: string
): { composePath: string | null; envPath: string | null; changed: boolean } {
	const composePath = rebaseStackPath(row.composePath, oldDir, newDir);
	const envPath = rebaseStackPath(row.envPath, oldDir, newDir);
	return { composePath, envPath, changed: composePath !== row.composePath || envPath !== row.envPath };
}

/** The rows to rewrite for a move from oldDir to newDir, limited to `onlyIds` when given. */
export function planStackSourceRebase(
	rows: Array<{ id: number; composePath: string | null; envPath: string | null }>,
	oldDir: string,
	newDir: string,
	onlyIds?: number[]
): Array<{ id: number; composePath: string | null; envPath: string | null }> {
	const plan: Array<{ id: number; composePath: string | null; envPath: string | null }> = [];
	for (const row of rows) {
		if (onlyIds && !onlyIds.includes(row.id)) continue;
		const next = rebaseStackSourceRow(row, oldDir, newDir);
		if (next.changed) plan.push({ id: row.id, composePath: next.composePath, envPath: next.envPath });
	}
	return plan;
}
