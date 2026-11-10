import { describe, test, expect } from 'bun:test';
import { parseRawContent, generateRawContent, textEditorContent, keysInRawContent, mergeParsedIntoVariables, type EnvVarLike, mergeVariablesIntoRawContent, injectedKeysNeedCollapse } from '../src/lib/utils/env-panel-core';
import { envValueToText, envValueToTextPreserving } from '../src/lib/utils/env-file-values';

/**
 * Replays what the panel does on save, so the #1620 data loss is covered by an
 * assertion rather than by reading the component.
 */
function saveFromTextView(rawContent: string, variables: EnvVarLike[]): EnvVarLike[] {
	const source = textEditorContent(rawContent, variables);
	const { vars } = parseRawContent(source);
	return mergeParsedIntoVariables(vars, variables, keysInRawContent(source)).filter((v) =>
		v.key.trim()
	);
}

/** Replays handleTextChange: what the user types replaces what the editor showed. */
function typeIntoEditor(
	typed: string,
	rawContent: string,
	variables: EnvVarLike[]
): { rawContent: string; variables: EnvVarLike[] } {
	const shownBefore = keysInRawContent(textEditorContent(rawContent, variables));
	const { vars } = parseRawContent(typed);
	return { rawContent: typed, variables: mergeParsedIntoVariables(vars, variables, shownBefore) };
}

describe('#1620 - a row added outside the panel survives a save in text view', () => {
	test('the bulk selector is kept when the .env file is empty', () => {
		// The secret provider picker writes only into `variables`; the file is still empty,
		// so the editor is showing the generated text.
		const variables: EnvVarLike[] = [
			{ key: 'DOCKHAND_SECRET_SELECTOR', value: 'env-abc123', isSecret: false }
		];
		const saved = saveFromTextView('', variables);
		expect(saved).toEqual([
			{ key: 'DOCKHAND_SECRET_SELECTOR', value: 'env-abc123', isSecret: false }
		]);
	});

	test('secrets are carried through untouched alongside it', () => {
		const variables: EnvVarLike[] = [
			{ key: 'DOCKHAND_SECRET_SELECTOR', value: 'env-abc123', isSecret: false },
			{ key: 'DB_PASSWORD', value: 's3cr3t', isSecret: true }
		];
		const saved = saveFromTextView('', variables);
		expect(saved.map((v) => v.key).sort()).toEqual(['DB_PASSWORD', 'DOCKHAND_SECRET_SELECTOR']);
		expect(saved.find((v) => v.key === 'DB_PASSWORD')?.value).toBe('s3cr3t');
	});

	test('the selector is kept when the .env file already has content', () => {
		// The commoner shape: a real .env exists, so the editor shows the file and the
		// selector row is not even visible. It must still survive the save.
		const variables: EnvVarLike[] = [
			{ key: 'FOO', value: 'bar', isSecret: false },
			{ key: 'DOCKHAND_SECRET_SELECTOR', value: 'env-abc123', isSecret: false }
		];
		const saved = saveFromTextView('FOO=bar\n', variables);
		expect(saved.map((v) => v.key).sort()).toEqual(['DOCKHAND_SECRET_SELECTOR', 'FOO']);
	});

	test('the file wins on value for a key it shares with a row', () => {
		const variables: EnvVarLike[] = [{ key: 'A', value: 'stale', isSecret: false }];
		const saved = saveFromTextView('A=fromfile\n', variables);
		expect(saved).toEqual([{ key: 'A', value: 'fromfile', isSecret: false }]);
	});
});

describe('#1620 - a row the user deleted in the editor stays deleted', () => {
	test('deleting a visible line removes it, and a save does not bring it back', () => {
		const before: EnvVarLike[] = [
			{ key: 'KEEP', value: '1', isSecret: false },
			{ key: 'DROPME', value: '2', isSecret: false }
		];
		const afterTyping = typeIntoEditor('KEEP=1\n', 'KEEP=1\nDROPME=2\n', before);
		expect(afterTyping.variables.map((v) => v.key)).toEqual(['KEEP']);

		const saved = saveFromTextView(afterTyping.rawContent, afterTyping.variables);
		expect(saved.map((v) => v.key)).toEqual(['KEEP']);
	});

	test('clearing the whole editor clears the visible rows but keeps secrets', () => {
		const before: EnvVarLike[] = [
			{ key: 'GONE', value: 'x', isSecret: false },
			{ key: 'DB_PASSWORD', value: 's3cr3t', isSecret: true }
		];
		const after = typeIntoEditor('', 'GONE=x\n', before);
		expect(after.variables.map((v) => v.key)).toEqual(['DB_PASSWORD']);
	});

	test('an off-screen row survives an edit that never showed it', () => {
		// The selector was written into variables while the editor showed only the file.
		const before: EnvVarLike[] = [
			{ key: 'FOO', value: 'bar', isSecret: false },
			{ key: 'DOCKHAND_SECRET_SELECTOR', value: 'env-abc', isSecret: false }
		];
		const after = typeIntoEditor('FOO=changed\n', 'FOO=bar\n', before);
		expect(after.variables.map((v) => v.key).sort()).toEqual(['DOCKHAND_SECRET_SELECTOR', 'FOO']);
		expect(after.variables.find((v) => v.key === 'FOO')?.value).toBe('changed');
	});
});

describe('textEditorContent', () => {
	test('prefers the file when it has content', () => {
		expect(textEditorContent('A=1\n', [{ key: 'B', value: '2' }])).toBe('A=1\n');
	});

	test('falls back to the rows when the file is empty or blank', () => {
		expect(textEditorContent('', [{ key: 'B', value: '2' }])).toBe('B=2\n');
		expect(textEditorContent('  \n ', [{ key: 'B', value: '2' }])).toBe('B=2\n');
	});

	test('empty on both sides', () => {
		expect(textEditorContent('', [])).toBe('');
	});
});

describe('generateRawContent', () => {
	test('renders non-secret rows and trims keys', () => {
		expect(generateRawContent([{ key: ' A ', value: '1' }, { key: 'B', value: '2' }])).toBe(
			'A=1\nB=2\n'
		);
	});

	test('skips secrets and unnamed rows', () => {
		expect(
			generateRawContent([
				{ key: 'A', value: '1' },
				{ key: 'S', value: 'x', isSecret: true },
				{ key: '   ', value: 'nameless' }
			])
		).toBe('A=1\n');
	});

	test('nothing to write', () => {
		expect(generateRawContent([])).toBe('');
		expect(generateRawContent([{ key: 'S', value: 'x', isSecret: true }])).toBe('');
	});
});

describe('parseRawContent', () => {
	test('reads keys and values, keeping = inside the value', () => {
		const { vars } = parseRawContent('A=1\nURL=postgres://u:p@h/db?x=1\n');
		expect(vars).toEqual([
			{ key: 'A', value: '1', isSecret: false },
			{ key: 'URL', value: 'postgres://u:p@h/db?x=1', isSecret: false }
		]);
	});

	test('skips blanks and comments without warning', () => {
		const { vars, warnings } = parseRawContent('\n# note\n\nA=1\n');
		expect(vars).toHaveLength(1);
		expect(warnings).toEqual([]);
	});

	test('warns on a line with no = and on an invalid name', () => {
		const { vars, warnings } = parseRawContent('JUSTTEXT\n1BAD=x\nOK=y\n');
		expect(vars).toEqual([{ key: 'OK', value: 'y', isSecret: false }]);
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain('Line 1');
		expect(warnings[1]).toContain('Line 2');
	});

	test('an empty value is a value', () => {
		expect(parseRawContent('EMPTY=\n').vars).toEqual([{ key: 'EMPTY', value: '', isSecret: false }]);
	});

	test('round-trips with generateRawContent', () => {
		const rows: EnvVarLike[] = [{ key: 'A', value: '1' }, { key: 'B', value: 'x=y' }];
		const { vars } = parseRawContent(generateRawContent(rows));
		expect(vars.map((v) => ({ key: v.key, value: v.value }))).toEqual(rows);
	});
});

describe('quoting across the text view', () => {
	test('a quoted .env value reaches the form without its quotes', () => {
		// The quotes are the file's syntax. Left on, a row marked secret is injected
		// through the process environment and the container receives them as content.
		const { vars } = parseRawContent('FOO="bar"\nBAZ=\'qux\'\nPLAIN=raw\n');
		expect(vars.map((v) => [v.key, v.value])).toEqual([
			['FOO', 'bar'],
			['BAZ', 'qux'],
			['PLAIN', 'raw']
		]);
	});

	test('a value is quoted on the way out only when it needs to be', () => {
		expect(generateRawContent([{ key: 'A', value: 'plain', isSecret: false }])).toBe('A=plain\n');
		expect(generateRawContent([{ key: 'A', value: 'has#hash', isSecret: false }])).toBe('A="has#hash"\n');
		expect(generateRawContent([{ key: 'A', value: ' pad ', isSecret: false }])).toBe('A=" pad "\n');
	});

	test('a value survives the round trip the panel puts it through', () => {
		// Either side of the panel can be edited, so a row rendered to text and parsed
		// back must be the same row - this is what stops a save rewriting a password.
		const values = [
			'bar', 'a b', 'has#hash', 'with"quote', "with'quote", 'dollar$VAR',
			'p@$$w0rd#1', '  pad  ', 'a=b', '"already"', 'back\\slash', 'line\nbreak', '$'
		];
		for (const value of values) {
			const text = generateRawContent([{ key: 'K', value, isSecret: false }]);
			expect(parseRawContent(text).vars[0]?.value).toBe(value);
		}
	});
});

/**
 * The panel is edited from both sides, so a value makes this trip on every save. Without
 * a matching reader and writer each save eats another layer of quoting until a
 * JSON-style list is no longer valid, so stability is the property that matters here,
 * not the exact spelling of the text.
 *
 * `mergeVariablesIntoRawContent` is the write side, called straight from the panel's
 * syncVariablesToRaw - so this exercises the real function rather than a copy of it.
 * A line whose value is unchanged keeps its own text, which is what makes an untouched
 * file byte-identical after a save.
 */
describe('a value survives repeated saves', () => {
	function save(rawContent: string, variables: EnvVarLike[]) {
		const shownBefore = keysInRawContent(rawContent);
		const { vars } = parseRawContent(rawContent);
		const merged = mergeParsedIntoVariables(vars, variables, shownBefore);
		return { rawContent: mergeVariablesIntoRawContent(rawContent, merged), variables: merged };
	}

	test('a nested-quote list is not eaten a layer at a time', () => {
		// A JSON-style list is the shape that shows the damage: one lost layer leaves
		// `"sub1.com","sub2.com"`, a second leaves `sub1.com","sub2.com`.
		let state = {
			rawContent: `HOSTNAMES='"sub1.com","sub2.com"'\n# a comment\nSIMPLE=value\n`,
			variables: [] as EnvVarLike[]
		};
		for (let i = 0; i < 5; i++) state = save(state.rawContent, state.variables);

		const hostnames = state.variables.find((v) => v.key === 'HOSTNAMES');
		expect(hostnames?.value).toBe('"sub1.com","sub2.com"');
		expect(state.rawContent).toContain('# a comment');
	});

	test('the text stops changing after the first save', () => {
		// A value is written in one canonical form, so a later save is a no-op. Without
		// that the file drifts on every visit even when nobody edited anything.
		let state = {
			rawContent: `HOSTNAMES='"sub1.com","sub2.com"'\nQUOTED="hello world"\nSPECIAL='password$123#!'\nPLAIN=value\n`,
			variables: [] as EnvVarLike[]
		};
		state = save(state.rawContent, state.variables);
		const afterFirst = state.rawContent;
		for (let i = 0; i < 4; i++) {
			state = save(state.rawContent, state.variables);
			expect(state.rawContent).toBe(afterFirst);
		}
	});

	test('an untouched file comes back byte-identical', () => {
		// The strongest statement of the property: a user who opens a stack and saves it
		// without editing anything must get their file back unchanged. A writer that
		// re-spells each line cannot promise that, and a `${NAME}` reference re-spelled as
		// a literal dollar stops resolving at deploy time.
		const file = [
			'DIRECTORY=/srv/data',
			'UPLOAD_LOCATION="${DIRECTORY}/immich"',
			"LITERAL='${NOT_A_REF}'",
			'DB_PASSWORD=p@$$w0rd',
			'# a comment',
			'PLAIN=value',
			''
		].join('\n');

		let state = { rawContent: file, variables: [] as EnvVarLike[] };
		for (let i = 0; i < 3; i++) state = save(state.rawContent, state.variables);
		expect(state.rawContent).toBe(file);
	});

	test('a variable with no line yet is appended, quoted as it needs', () => {
		const written = mergeVariablesIntoRawContent('EXISTING=keep\n', [
			{ key: 'EXISTING', value: 'keep', isSecret: false },
			{ key: 'ADDED', value: 'has#hash', isSecret: false },
			{ key: 'PLAIN', value: 'simple', isSecret: false }
		]);
		// The trailing newline leaves an empty field, which is kept as the blank line it
		// is, so an appended variable lands after it rather than on it.
		expect(written).toBe('EXISTING=keep\n\nADDED="has#hash"\nPLAIN=simple\n');
	});

	test('comments and blank lines are carried over, and a deleted variable is dropped', () => {
		const written = mergeVariablesIntoRawContent(
			'# header\n\nKEEP=yes\nGONE=no\n# trailing\n',
			[{ key: 'KEEP', value: 'yes', isSecret: false }]
		);
		expect(written).toBe('# header\n\nKEEP=yes\n# trailing\n');
	});

	test('a secret never reaches the file', () => {
		const written = mergeVariablesIntoRawContent('PUBLIC=yes\n', [
			{ key: 'PUBLIC', value: 'yes', isSecret: false },
			{ key: 'TOKEN', value: 'hunter2', isSecret: true }
		]);
		expect(written).toBe('PUBLIC=yes\n');
		expect(written).not.toContain('hunter2');
	});

	test('a single-quoted value keeps its dollar and hash through a save', () => {
		// A single quote makes a raw string, so eating it changes the password itself.
		let state = { rawContent: `SPECIAL='password$123#!'\n`, variables: [] as EnvVarLike[] };
		for (let i = 0; i < 3; i++) state = save(state.rawContent, state.variables);
		expect(state.variables.find((v) => v.key === 'SPECIAL')?.value).toBe('password$123#!');
	});
});

describe('injectedKeysNeedCollapse (provider banner collapse threshold)', () => {
	// A short injected list reads better inline; a long one gets a collapse toggle.
	// The default threshold is 5, so the boundary is 4 (inline) vs 5 (collapsible).
	test('a list shorter than the threshold stays inline', () => {
		expect(injectedKeysNeedCollapse(0)).toBe(false);
		expect(injectedKeysNeedCollapse(1)).toBe(false);
		expect(injectedKeysNeedCollapse(4)).toBe(false);
	});

	test('a list at or above the threshold is collapsible', () => {
		expect(injectedKeysNeedCollapse(5)).toBe(true);
		expect(injectedKeysNeedCollapse(6)).toBe(true);
		expect(injectedKeysNeedCollapse(46)).toBe(true);
	});

	test('the threshold is overridable', () => {
		expect(injectedKeysNeedCollapse(2, 3)).toBe(false);
		expect(injectedKeysNeedCollapse(3, 3)).toBe(true);
	});
});
