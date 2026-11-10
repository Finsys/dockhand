/**
 * Pure helpers for the stack environment-variables panel.
 *
 * The panel holds the same data twice: `variables` (rows, including secrets) and
 * `rawContent` (the .env text). Either side can be edited, so every crossing between
 * them goes through here.
 *
 * A row holds the VALUE; the text holds it in the file's syntax. Quoting and escaping
 * belong to the text alone, so `envValueFromText` and `envValueToText` are a matching
 * pair and every crossing uses them - a secret reaches the container through the
 * process environment rather than the file, so a quote left on a value becomes part of
 * it.
 */

import { envValueFromText, envValueToText, envValueToTextPreserving } from './env-file-values';

export interface EnvVarLike {
	key: string;
	value: string;
	isSecret?: boolean;
}

export interface ParsedRawContent<T extends EnvVarLike> {
	vars: T[];
	warnings: string[];
}

/** Parse .env text into non-secret rows, collecting a warning per unusable line. */
export function parseRawContent(content: string): ParsedRawContent<EnvVarLike & { isSecret: false }> {
	const vars: (EnvVarLike & { isSecret: false })[] = [];
	const warnings: string[] = [];
	let lineNum = 0;

	for (const line of content.split('\n')) {
		lineNum++;
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;

		const eqIndex = trimmed.indexOf('=');
		if (eqIndex === -1) {
			warnings.push(
				`Line ${lineNum}: "${trimmed.slice(0, 30)}${trimmed.length > 30 ? '...' : ''}" (no = found)`
			);
			continue;
		}

		const key = trimmed.slice(0, eqIndex).trim();
		const value = envValueFromText(trimmed.slice(eqIndex + 1));
		if (!key) continue;

		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
			warnings.push(`Line ${lineNum}: "${key}" (invalid variable name)`);
			continue;
		}
		vars.push({ key, value, isSecret: false });
	}

	return { vars, warnings };
}

/** Render non-secret rows as .env text. Empty when there is nothing to write. */
export function generateRawContent(variables: EnvVarLike[]): string {
	const nonSecrets = variables.filter((v) => v.key.trim() && !v.isSecret);
	if (nonSecrets.length === 0) return '';
	return nonSecrets.map((v) => `${v.key.trim()}=${envValueToText(v.value)}`).join('\n') + '\n';
}

/**
 * Rows written back over an existing .env text, keeping its comments and its layout.
 *
 * A line whose value is unchanged is left exactly as it stands, which is what makes an
 * untouched file byte-identical after a save - and keeps a `${NAME}` reference from being
 * re-spelled as a literal dollar. A line whose variable is gone is dropped; a row with no
 * line yet is appended.
 */
export function mergeVariablesIntoRawContent(
	rawContent: string,
	variables: EnvVarLike[]
): string {
	const nonSecrets = variables.filter((v) => v.key.trim() && !v.isSecret);
	const byKey = new Map(nonSecrets.map((v) => [v.key.trim(), v]));
	const written = new Set<string>();
	const out: string[] = [];

	for (const line of rawContent.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			out.push(line);
			continue;
		}

		const eqIndex = trimmed.indexOf('=');
		if (eqIndex > 0) {
			const key = trimmed.slice(0, eqIndex).trim();
			if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
				const row = byKey.get(key);
				if (row) {
					const existing = trimmed.slice(eqIndex + 1);
					out.push(`${key}=${envValueToTextPreserving(row.value, existing)}`);
					written.add(key);
				}
				continue;
			}
		}

		out.push(line);
	}

	for (const row of nonSecrets) {
		if (!written.has(row.key.trim())) {
			out.push(`${row.key.trim()}=${envValueToText(row.value)}`);
		}
	}

	const joined = out.join('\n');
	return joined && !joined.endsWith('\n') ? `${joined}\n` : joined;
}

/**
 * The text the editor shows, and so the text to parse back when saving or leaving text
 * view: the file when it has content, otherwise the rows rendered as text.
 *
 * Reading `rawContent` instead is what loses data - with an empty .env the two differ,
 * and parsing the empty one drops every non-secret row the user can see, including a
 * bulk selector written into `variables` by the secret provider picker (#1620).
 */
export function textEditorContent(rawContent: string, variables: EnvVarLike[]): string {
	return rawContent.trim() ? rawContent : generateRawContent(variables);
}

/**
 * Fold the text view's parsed rows back into the panel's variables.
 *
 * The editor only ever shows non-secret rows that reached the .env text, so parsing it
 * alone would discard two things it never had a chance to display: secrets, and rows
 * written straight into `variables` from outside the panel - the secret provider's bulk
 * selector being the one users hit (#1620).
 *
 * `editorKeys` is what the editor was showing before this edit. A row missing from both
 * that set and the parsed result was never on screen, so it is carried over; a row that
 * WAS on screen and is now gone was deleted by the user, so it stays deleted.
 */
export function mergeParsedIntoVariables<T extends EnvVarLike>(
	parsed: T[],
	variables: T[],
	editorKeys: ReadonlySet<string>
): T[] {
	const parsedKeys = new Set(parsed.map((v) => v.key.trim()));
	const offScreen = variables.filter(
		(v) => !v.isSecret && v.key.trim() && !parsedKeys.has(v.key.trim()) && !editorKeys.has(v.key.trim())
	);
	const secrets = variables.filter((v) => v.isSecret);
	return [...parsed, ...offScreen, ...secrets];
}

/** The non-secret keys a given editor text is displaying. */
export function keysInRawContent(content: string): Set<string> {
	return new Set(parseRawContent(content).vars.map((v) => v.key));
}

/**
 * Whether the provider-injected key list is long enough to warrant a collapse toggle.
 * A handful of keys reads better shown inline; a long list otherwise dominates the
 * env-vars panel. The threshold is the default, overridable for a test.
 */
export function injectedKeysNeedCollapse(count: number, threshold = 5): boolean {
	return count >= threshold;
}
