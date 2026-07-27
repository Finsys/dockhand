/**
 * Pure decision for the "Backup helper image" setting in Settings → Backups.
 *
 * The field is pre-filled with the value the API returned — either the user's
 * saved override, or (when nothing is saved) the engine's real version-pinned
 * default (fnsys/dockhand-backup:<version>). We must persist ONLY when the user
 * actually changed it: saving the pre-filled versioned default would pin the DB to
 * that exact version, and since the DB setting wins over the computed default, a
 * later app upgrade would keep using the OLD helper (a stale helper — see
 * src/lib/server/backups/restic.ts). Not saving an unchanged value keeps the DB row
 * empty so the engine tracks the app version automatically.
 */

/**
 * Decide whether to persist the backup helper image on Save.
 *
 * @param current the current field value (trimmed comparison; leading/trailing
 *        whitespace never counts as a change)
 * @param initial the value the field was loaded with (API's saved-or-default)
 * @returns true only when the user meaningfully changed the value
 */
export function shouldSaveBackupImage(current: string, initial: string): boolean {
	return (current ?? '').trim() !== (initial ?? '').trim();
}
