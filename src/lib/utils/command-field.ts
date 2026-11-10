// The container form edits Cmd/Entrypoint as one line of text. Plain words are split
// with parseShellCommand; an array that does not survive that - quotes inside an
// argument, a newline the single-line input cannot hold - is shown, and read back, as a
// JSON array (the exec form), so every array round-trips exactly.
import { parseShellCommand } from './shell';

/** Text in the JSON exec form: starts with a quoted first element, so it is an array a
 * user is editing rather than a shell `[ -f x ]` test. */
function looksLikeJsonArray(trimmed: string): boolean {
	return /^\[\s*"/.test(trimmed);
}

function asStringArray(trimmed: string): string[] | null {
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (Array.isArray(parsed) && parsed.every((a) => typeof a === 'string')) return parsed;
	} catch {
		// not JSON
	}
	return null;
}

/** Why a command field cannot be saved, or null when it can. */
export function commandTextError(text: string): string | null {
	const trimmed = text.trim();
	if (looksLikeJsonArray(trimmed) && asStringArray(trimmed) === null) {
		return 'Not a valid JSON array of strings. Fix the quoting or clear the field.';
	}
	return null;
}

/** Command text from the form as the array Docker takes. */
export function parseCommandText(text: string): string[] {
	const trimmed = text.trim();
	if (trimmed.startsWith('[')) {
		const arr = asStringArray(trimmed);
		if (arr) return arr;
	}
	return parseShellCommand(trimmed);
}

function sameArgs(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Cmd/Entrypoint array as the single line the form edits. */
export function formatCommandArgs(args: string[] | null | undefined): string {
	if (!args || args.length === 0) return '';
	// A newline cannot survive a single-line input, so such an argument needs the JSON form.
	if (args.some((a) => /[\r\n]/.test(a))) return JSON.stringify(args);
	const plain = args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ');
	return sameArgs(parseCommandText(plain), args) ? plain : JSON.stringify(args);
}

/**
 * What the update payload carries for a command field: undefined (key left out, the
 * server keeps the container's array as it is) when the text is unchanged, null when
 * it was cleared, else the parsed array.
 */
export function commandPayload(text: string, originalText: string): string[] | null | undefined {
	const trimmed = text.trim();
	if (trimmed === originalText.trim()) return undefined;
	if (!trimmed) return null;
	const args = parseCommandText(trimmed);
	return args.length > 0 ? args : null;
}
