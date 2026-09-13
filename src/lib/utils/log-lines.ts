import { GIT_LOGO_PATH } from '$lib/icons/git-logo-path';

// A line beginning with this ASCII marker renders with a small leading git icon
// (the producer -- git stack deploy -- prefixes its own stage lines with it so they
// read as git operations amid the compose output). Compose output never starts a
// line with it, so a match is unambiguous; a stray match only adds a harmless icon.
export const GIT_LINE_MARKER = '@@git@@ ';

// Inline generic Git logo, sized to sit on a log line. Inlined as a string (not a
// component) because the log body is rendered as raw HTML via {@html}, which can't mount
// a Svelte component -- so it shares GitGenericIcon's path via GIT_LOGO_PATH instead of
// duplicating it. currentColor keeps it monochrome; size/spacing/opacity from CSS.
const GIT_ICON_SVG =
	'<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" class="log-git-icon" aria-hidden="true">' +
	`<path d="${GIT_LOGO_PATH}"/></svg>`;

// Removes the leading git marker from every line -- for copy/download, where the log
// is read as plain text outside the viewer (the icon only exists in the rendered DOM).
export function stripLogMarkers(text: string): string {
	return text
		.split('\n')
		.map((line) => (line.startsWith(GIT_LINE_MARKER) ? line.slice(GIT_LINE_MARKER.length) : line))
		.join('\n');
}

export function wrapHtmlLines(html: string): string {
	return html
		.split('\n')
		.map((line) => {
			if (line.startsWith(GIT_LINE_MARKER)) {
				const rest = line.slice(GIT_LINE_MARKER.length);
				return `<div class="log-line log-line-git">${GIT_ICON_SVG}${rest || ' '}</div>`;
			}
			return `<div class="log-line">${line || ' '}</div>`;
		})
		.join('');
}
