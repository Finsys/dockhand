import { describe, test, expect } from 'bun:test';
import {
	parseRawContent,
	generateRawContent,
	textEditorContent,
	keysInRawContent,
	mergeParsedIntoVariables,
	type EnvVarLike
} from '../src/lib/utils/env-panel-core';

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
