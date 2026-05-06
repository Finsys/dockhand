/**
 * Dockhand Container Label Controls
 *
 * Docker container labels that control Dockhand behavior:
 * - dockhand.update=false  — Skip this container during auto-updates and batch updates
 * - dockhand.hidden=true   — Hide this container from the Dockhand UI
 * - dockhand.notify=false  — Suppress notifications for this container's events
 *
 * All label values are case-insensitive and accept: true/yes/1 and false/no/0.
 * The opt-out model means labels override DB settings (label wins).
 */

/** Recognized Dockhand label keys */
export const DOCKHAND_LABELS = {
	UPDATE: 'dockhand.update',
	HIDDEN: 'dockhand.hidden',
	NOTIFY: 'dockhand.notify',
} as const;

const TRUTHY_VALUES = new Set(['true', 'yes', '1']);
const FALSY_VALUES = new Set(['false', 'no', '0']);

/**
 * Parse a label value as a boolean.
 * Returns true for: true, TRUE, yes, YES, 1
 * Returns false for: false, FALSE, no, NO, 0
 * Returns undefined for missing or unrecognized values.
 */
function parseLabelBool(value: string | undefined | null): boolean | undefined {
	if (value == null) return undefined;
	const normalized = value.trim().toLowerCase();
	if (TRUTHY_VALUES.has(normalized)) return true;
	if (FALSY_VALUES.has(normalized)) return false;
	return undefined;
}

/**
 * Get a label value from a Docker labels object.
 */
function getLabel(labels: Record<string, string> | undefined | null, key: string): string | undefined {
	if (!labels) return undefined;
	return labels[key];
}

/**
 * Check if a container should be skipped during auto-updates.
 * Returns true if dockhand.update is explicitly set to false/no/0.
 * Default (no label): allow updates (opt-out model).
 */
export function isUpdateDisabledByLabel(labels: Record<string, string> | undefined | null): boolean {
	const value = parseLabelBool(getLabel(labels, DOCKHAND_LABELS.UPDATE));
	return value === false; // explicitly disabled
}

/**
 * Check if a container should be hidden from the UI.
 * Returns true if dockhand.hidden is explicitly set to true/yes/1.
 * Default (no label): visible (opt-out model).
 */
export function isHiddenByLabel(labels: Record<string, string> | undefined | null): boolean {
	const value = parseLabelBool(getLabel(labels, DOCKHAND_LABELS.HIDDEN));
	return value === true; // explicitly hidden
}

/**
 * Check if notifications should be suppressed for this container.
 * Returns true if dockhand.notify is explicitly set to false/no/0.
 * Default (no label): send notifications (opt-out model).
 */
export function isNotifyDisabledByLabel(labels: Record<string, string> | undefined | null): boolean {
	const value = parseLabelBool(getLabel(labels, DOCKHAND_LABELS.NOTIFY));
	return value === false; // explicitly disabled
}

/**
 * Extract all Dockhand label states from a container's labels.
 * Useful for including in API responses so the frontend knows about label overrides.
 */
export function getDockhandLabels(labels: Record<string, string> | undefined | null): {
	updateDisabled: boolean;
	hidden: boolean;
	notifyDisabled: boolean;
} {
	return {
		updateDisabled: isUpdateDisabledByLabel(labels),
		hidden: isHiddenByLabel(labels),
		notifyDisabled: isNotifyDisabledByLabel(labels),
	};
}
