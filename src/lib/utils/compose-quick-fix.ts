/**
 * Compose Validate quick-fix: the QuickFix shape + a pure line-based applier.
 *
 * Lives in $lib/utils (not $lib/server) because BOTH sides need it: rules emit a
 * QuickFix server-side, and the stack editor applies it client-side. Pure and
 * newline-preserving so it is trivially unit-tested and identical on both ends.
 */

/**
 * A deterministic, one-line edit that resolves a finding. Only rules whose fix is
 * UNAMBIGUOUS carry one (a typo with a known suggestion, an obsolete key to drop, a
 * db-port to bind to localhost) - never a fix that requires the user to choose.
 *   - delete-line: remove the whole 1-based line.
 *   - replace-in-line: replace the FIRST `find` on the line with `replace`.
 *   - insert-after: insert `text` as a new line right AFTER the 1-based line (text
 *     carries its own indentation; the rule computes it).
 */
export type QuickFix =
	| { kind: 'delete-line'; line: number }
	| { kind: 'replace-in-line'; line: number; find: string; replace: string; at?: number }
	| { kind: 'insert-after'; line: number; text: string };

/**
 * Stable identity of a finding, used for the {#each} key, optimistic drop, and set
 * comparison on the client - and it MUST match the server's dedup key
 * (compose-validate/index.ts) so the two never disagree. Delimited so distinct fields
 * can't collide (ruleId 'A'+line 1 vs ruleId 'A1'+no line both -> 'A1' without it).
 */
export function findingKey(f: { ruleId: string; line?: number; message: string }): string {
	return `${f.ruleId}|${f.line ?? ''}|${f.message}`;
}

/**
 * Apply a QuickFix to compose source text. Out-of-range / no-match fixes return the
 * source unchanged (the caller re-validates afterwards, so a stale fix simply no-ops).
 */
export function applyQuickFix(source: string, fix: QuickFix): string {
	// Split on \n only, so \r on CRLF lines is preserved: a per-line edit never
	// rewrites the whole file's line endings.
	const lines = source.split('\n');
	const idx = fix.line - 1; // fix.line is 1-based
	if (idx < 0 || idx >= lines.length) return source;

	if (fix.kind === 'delete-line') {
		lines.splice(idx, 1);
		return lines.join('\n');
	}

	if (fix.kind === 'insert-after') {
		lines.splice(idx + 1, 0, fix.text);
		return lines.join('\n');
	}

	// replace-in-line: swap `find` with `replace`. When the rule provides `at` (the
	// token's 0-based column, which for a quoted value points at the opening quote),
	// look for `find` at or just after `at` (within a couple of chars, to skip a quote/
	// space). This anchors to the intended occurrence so a token that is a substring of
	// an earlier token can't be corrupted; a shifted line (stale batch offset) finds no
	// nearby match and is a no-op rather than a wrong edit. Without `at`, first match.
	const line = lines[idx];
	let at: number;
	if (typeof fix.at === 'number' && fix.at >= 0) {
		const found = line.indexOf(fix.find, fix.at);
		if (found === -1 || found - fix.at > 2) return source; // stale/shifted - re-validate re-anchors
		at = found;
	} else {
		at = line.indexOf(fix.find);
		if (at === -1) return source;
	}
	lines[idx] = line.slice(0, at) + fix.replace + line.slice(at + fix.find.length);
	return lines.join('\n');
}
