import { describe, test, expect } from 'bun:test';
import {
	EDITOR_THEMES,
	EDITOR_THEME_IDS,
	getEditorThemeMeta,
	isValidEditorThemeId
} from '../src/lib/utils/editor-themes';
import { getEditorThemeExtension } from '../src/lib/utils/editor-theme-extensions';

describe('editor-themes (light metadata, no @uiw import)', () => {
	test("'default' is first", () => {
		expect(EDITOR_THEMES[0].id).toBe('default');
	});

	test('theme ids are unique (ids are persisted, must not collide)', () => {
		const seen = new Set<string>();
		for (const id of EDITOR_THEME_IDS) {
			expect(seen.has(id), `duplicate id ${id}`).toBe(false);
			seen.add(id);
		}
	});

	test('every theme has a non-empty label', () => {
		for (const t of EDITOR_THEMES) {
			expect(t.label.length, `${t.id} label`).toBeGreaterThan(0);
		}
	});

	test('isValidEditorThemeId accepts known ids and rejects everything else', () => {
		expect(isValidEditorThemeId('default')).toBe(true);
		expect(isValidEditorThemeId('dracula')).toBe(true);
		expect(isValidEditorThemeId('nord')).toBe(true);
		expect(isValidEditorThemeId('not-a-theme')).toBe(false);
		expect(isValidEditorThemeId('')).toBe(false);
		expect(isValidEditorThemeId(undefined)).toBe(false);
		expect(isValidEditorThemeId(null)).toBe(false);
		expect(isValidEditorThemeId(42)).toBe(false);
	});

	test('getEditorThemeMeta falls back to default for unknown/empty ids', () => {
		expect(getEditorThemeMeta('dracula').id).toBe('dracula');
		expect(getEditorThemeMeta('not-a-theme').id).toBe('default');
		expect(getEditorThemeMeta(undefined).id).toBe('default');
		expect(getEditorThemeMeta(null).id).toBe('default');
	});

	test('both dark and light themes are offered', () => {
		expect(EDITOR_THEMES.some((t) => t.dark && t.id !== 'default')).toBe(true);
		expect(EDITOR_THEMES.some((t) => !t.dark)).toBe(true);
	});
});

describe('editor-theme-extensions (client-only, heavy)', () => {
	test("'default' and unknown ids resolve to null (built-in theme in CodeEditor)", () => {
		expect(getEditorThemeExtension('default')).toBeNull();
		expect(getEditorThemeExtension(undefined)).toBeNull();
		expect(getEditorThemeExtension(null)).toBeNull();
		expect(getEditorThemeExtension('not-a-theme')).toBeNull();
	});

	test('every non-default theme id maps to a real CM6 extension', () => {
		for (const t of EDITOR_THEMES) {
			if (t.id === 'default') continue;
			const ext = getEditorThemeExtension(t.id);
			expect(ext, `${t.id} must have an extension`).not.toBeNull();
			expect(ext, `${t.id} extension must be defined`).toBeDefined();
		}
	});
});
