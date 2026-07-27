/**
 * Pure volume-prune logic — NO ./db or ./docker imports so it loads under
 * `bun test` (both of those pull in better-sqlite3, which crashes the test
 * runner). Mirrors the backup `*-core.ts` split. The effectful part (list +
 * remove via the Docker API) lives in docker.ts:pruneVolumes and calls in here.
 */

/**
 * Internal Dockhand volumes that must NEVER be pruned. These are the scanner
 * vulnerability-database caches (grype/trivy). They are NAMED volumes that sit
 * unused between scans, so a plain Docker `volumes/prune?all=true` would delete
 * them — forcing an expensive DB re-download on the next scan. Excluded by name.
 * Single source of truth: scanner.ts derives its own consts from this list.
 */
export const PROTECTED_VOLUME_NAMES = ['dockhand-grype-db', 'dockhand-trivy-db'] as const;

/**
 * Given the volume list (each with its in-use `usedBy` set) and the protected
 * names, return the names to prune: those that are UNUSED (`usedBy` empty) and
 * NOT protected. `usedBy` is computed by listVolumes against ALL containers
 * (running + stopped), so a volume held by a stopped container is correctly
 * treated as in-use and kept — matching Docker's own prune semantics.
 */
export function selectVolumesToPrune(
	volumes: Array<{ name: string; usedBy: unknown[] }>,
	protectedNames: readonly string[] = PROTECTED_VOLUME_NAMES,
): string[] {
	const protectedSet = new Set(protectedNames);
	return volumes
		.filter((v) => v.usedBy.length === 0 && !protectedSet.has(v.name))
		.map((v) => v.name);
}
