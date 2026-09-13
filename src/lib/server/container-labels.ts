/**
 * Dockhand Container Label Controls
 *
 * Docker container labels that control Dockhand behavior:
 * - dockhand.update=false  — Skip this container during auto-updates and batch updates
 * - dockhand.hidden=true   — Hide this container from the Dockhand UI
 * - dockhand.notify=false  — Suppress notifications for this container's events
 * - dockhand.url=<url>     — Custom clickable URL displayed alongside container ports
 * - dockhand.port.<hostPort>.url=<url> — Override the click URL for a specific published port
 * - dockhand.order=<int>  — Controls display order within a stack (lower = first, default 0)
 * - dockhand.adopt=false  — Prevent this stack from being adopted (any container in the stack)
 * - dockhand.version.pattern=regex:... — Override how the newer-version check reads
 *     this image's tags, for non-standard tag schemes (named groups major/minor/patch)
 *
 * All label values are case-insensitive and accept: true/yes/1 and false/no/0.
 * The opt-out model means labels override DB settings (label wins).
 */

import { compileVersionPattern } from './semver/tag-parser';

/** Recognized Dockhand label keys */
export const DOCKHAND_LABELS = {
	UPDATE: 'dockhand.update',
	HIDDEN: 'dockhand.hidden',
	NOTIFY: 'dockhand.notify',
	URL: 'dockhand.url',
	ORDER: 'dockhand.order',
	ADOPT: 'dockhand.adopt',
	VERSION_PATTERN: 'dockhand.version.pattern',
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
 * Compile this container's `dockhand.version.pattern` label into a RegExp for the
 * newer-version check's override, or null when absent/invalid. A bad pattern
 * degrades to null (default parser), so a typo never breaks the update check.
 */
export function getVersionPatternOverride(
	labels: Record<string, string> | undefined | null
): RegExp | null {
	return compileVersionPattern(getLabel(labels, DOCKHAND_LABELS.VERSION_PATTERN));
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
 * Check if a single container opts out of stack adoption.
 * Returns true if dockhand.adopt is explicitly set to false/no/0.
 * Default (no label): adoptable (opt-out model).
 */
export function isAdoptDisabledByLabel(labels: Record<string, string> | undefined | null): boolean {
	return parseLabelBool(getLabel(labels, DOCKHAND_LABELS.ADOPT)) === false;
}

/**
 * Check if a stack should be excluded from adoption. A stack is unadoptable when
 * ANY of its containers carries dockhand.adopt=false. Only enforceable while the
 * stack is running (the label lives on containers, not the compose file).
 */
export function isStackUnadoptable(
	containerLabels: Array<Record<string, string> | undefined | null>
): boolean {
	return containerLabels.some(isAdoptDisabledByLabel);
}

/**
 * Get the custom URL from dockhand.url label.
 * Returns the URL string if set, or undefined.
 */
export function getCustomUrl(labels: Record<string, string> | undefined | null): string | undefined {
	const value = getLabel(labels, DOCKHAND_LABELS.URL);
	return value?.trim() || undefined;
}

/**
 * Get the sort order value from dockhand.order label.
 * Returns the parsed integer, or 0 for missing/invalid values.
 */
export function getOrderValue(labels: Record<string, string> | undefined | null): number {
	const value = getLabel(labels, DOCKHAND_LABELS.ORDER);
	if (value == null) return 0;
	const parsed = parseInt(value.trim(), 10);
	return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Extract all Dockhand label states from a container's labels.
 * Useful for including in API responses so the frontend knows about label overrides.
 */
export function getDockhandLabels(labels: Record<string, string> | undefined | null): {
	updateDisabled: boolean;
	hidden: boolean;
	notifyDisabled: boolean;
	customUrl?: string;
} {
	return {
		updateDisabled: isUpdateDisabledByLabel(labels),
		hidden: isHiddenByLabel(labels),
		notifyDisabled: isNotifyDisabledByLabel(labels),
		customUrl: getCustomUrl(labels),
	};
}
