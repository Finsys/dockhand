/**
 * Which general settings every signed-in user may read.
 *
 * The page renders for everybody, so the values that decide how a date or a log line
 * is drawn have to reach everybody. The rest of the table does not: scanner images and
 * arguments, the network and DNS those scanners run on, stack paths on the host, and
 * the collection and cleanup schedules describe how the installation is built and
 * operated. Somebody who may not view settings should not learn them by opening a tab.
 *
 * An allow-list rather than a deny-list: a setting added later is private until
 * somebody decides otherwise, which is the safe direction to be wrong in.
 */

/** Settings that only affect how the interface looks or reads. */
export const PRESENTATION_SETTINGS = [
	'actionIconSize',
	'animateIcons',
	'coloredActionButtons',
	'compactPorts',
	'confirmDestructive',
	'darkTheme',
	'dateFormat',
	'downloadFormat',
	'editorFont',
	'editorIndentGuides',
	'editorTheme',
	'font',
	'fontSize',
	'formatLogTimestamps',
	'gridFontSize',
	'highlightUpdates',
	'labelFilterMode',
	'lightTheme',
	'logBufferSizeKb',
	'logMaxLines',
	'showExposedPorts',
	'showGitCommitHash',
	'showImageChangelogLinks',
	'showStoppedContainers',
	'showWhatsNew',
	'stackLogOperations',
	'terminalFont',
	'timeFormat',
	'useSelfhstIcons',
	// Not presentation as such, but every screen formats timestamps with it.
	'defaultTimezone',
	// The starting point a new stack is seeded from. Written for the people who author
	// stacks, who need no settings permission to do so, and it describes nothing about
	// how this host is built.
	'defaultComposeTemplate'
] as const;

const PRESENTATION = new Set<string>(PRESENTATION_SETTINGS);

/**
 * The settings a caller may see.
 *
 * With permission to view settings, everything. Without it, only the presentation
 * half - the operational values are dropped rather than blanked, so a reader cannot
 * tell a hidden setting from one that was never configured.
 */
export function visibleGeneralSettings<T extends object>(
	all: T,
	canViewSettings: boolean
): Partial<T> {
	if (canViewSettings) return all;

	const visible: Partial<T> = {};
	for (const key of Object.keys(all) as (keyof T & string)[]) {
		if (PRESENTATION.has(key)) {
			visible[key] = all[key];
		}
	}
	return visible;
}
