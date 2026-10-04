/**
 * Display-only container name from the `dockhand.name` label. UI text only:
 * anything keyed by name (icons, tags, auto-update, API calls) must keep `c.name`.
 */

export const DISPLAY_NAME_LABEL = 'dockhand.name';

export function containerDisplayName(c: { name: string; labels?: Record<string, string> | null }): string {
	return c.labels?.[DISPLAY_NAME_LABEL]?.trim() || c.name;
}
