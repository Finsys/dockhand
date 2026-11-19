/** The backup group's events, which the event editor hides without the backups feature. */
export const BACKUP_EVENT_IDS: readonly string[] = ['backup_success', 'backup_failed', 'restore_success', 'restore_failed'];

const BACKUP_IDS = new Set(BACKUP_EVENT_IDS);

/** How many of a channel's events the editor shows: without the backups feature its group is hidden. */
export function shownEventCount(eventTypes: string[], backupsEnabled: boolean): number {
	return backupsEnabled ? eventTypes.length : eventTypes.filter((id) => !BACKUP_IDS.has(id)).length;
}
