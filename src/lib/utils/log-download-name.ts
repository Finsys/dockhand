/**
 * Builds the file name offered when downloading a log. The title is caller-supplied
 * (a container name today, a stack name tomorrow), so path separators are stripped:
 * a download name is not a path, and nothing good comes of letting one look like one.
 */
export function downloadFileName(title: string | undefined): string {
	const safe = (title ?? '').replace(/[/\\]/g, '').replace(/\.\./g, '').trim();
	return safe ? `${safe}-logs.txt` : 'logs.txt';
}

// A CSI sequence is ESC [ , then parameter bytes (0x30-0x3F, which includes '?' for
// private modes), then intermediate bytes (0x20-0x2F), then one final byte (0x40-0x7E).
// Matching the full grammar rather than just digits and semicolons matters here: compose's
// progress display hides and shows the cursor with ESC[?25l / ESC[?25h on every redraw, and
// '?' is a parameter byte. A pattern that misses those leaves them in the very output this
// viewer exists to show.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-?]*[ -\/]*[@-~]/g;

/**
 * Strips ANSI escape sequences (color codes, cursor movement, etc.) from log text.
 * Copied or downloaded logs are read outside a terminal -- a `.log` file full of
 * `\u001b[32m` sequences is unreadable with `cat` and unusable in a diff or grep.
 */
export function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, '');
}
