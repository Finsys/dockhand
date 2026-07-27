/**
 * Pure predicate for reaping orphaned backup/restore helper containers left by a
 * crashed process. NO DB / docker import, so it is unit-testable directly.
 *
 * Ownership is fail-closed on purpose: on a shared Docker daemon another Dockhand
 * install's in-flight helper matches our name prefix too. We only reap a container
 * whose `dockhand.instance` label equals OUR instance id — a missing or foreign
 * label means we can't prove we own it, so we leave it alone rather than kill a
 * co-located install's live helper.
 */

/** Name prefixes the backup/restore engine gives its throwaway helper containers. */
export const BACKUP_HELPER_PREFIXES = ['dockhand-backup', 'dockhand-restore'] as const;

/** The label key stamped on every helper container carrying its owner's instance id. */
export const INSTANCE_LABEL = 'dockhand.instance';

/**
 * True iff a container is one of THIS installation's orphaned backup/restore
 * helpers: its name has a helper prefix AND its instance label matches. A missing
 * or foreign label fails closed (returns false).
 */
export function isOwnedBackupHelper(
	name: string | undefined,
	labels: Record<string, string> | undefined,
	myInstance: string,
): boolean {
	if (!name) return false;
	if (!BACKUP_HELPER_PREFIXES.some((p) => name.startsWith(p))) return false;
	return labels?.[INSTANCE_LABEL] === myInstance;
}
