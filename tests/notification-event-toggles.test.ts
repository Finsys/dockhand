// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Every environment-scoped event a channel can subscribe to must have a toggle in the
// editor, otherwise it is subscribed by default and cannot be switched off (#615).
const root = join(import.meta.dir, '..');
const dbSrc = readFileSync(join(root, 'src/lib/server/db.ts'), 'utf8');
const editorSrc = readFileSync(join(root, 'src/routes/settings/environments/EventTypesEditor.svelte'), 'utf8');

function envScopedEventIds(): string[] {
	return [...dbSrc.matchAll(/\{\s*id:\s*'([a-z_]+)'[^}\n]*scope:\s*'environment'\s*\}/g)].map((m) => m[1]);
}

function editorEventIds(): string[] {
	const start = editorSrc.indexOf('NOTIFICATION_EVENT_GROUPS');
	const body = editorSrc.slice(start, editorSrc.indexOf('];', start));
	return [...body.matchAll(/\{\s*id:\s*'([a-z_]+)',\s*label:[^}\n]*description:[^}\n]*\}/g)].map((m) => m[1]);
}

describe('EventTypesEditor toggles', () => {
	test('parses a non-trivial event list from both sources', () => {
		expect(envScopedEventIds().length).toBeGreaterThan(20);
		expect(editorEventIds().length).toBeGreaterThan(20);
	});

	test('every environment-scoped event has a toggle', () => {
		const editor = new Set(editorEventIds());
		expect(envScopedEventIds().filter((id) => !editor.has(id))).toEqual([]);
	});

	test('the editor offers no event the backend does not define as environment-scoped', () => {
		const backend = new Set(envScopedEventIds());
		expect(editorEventIds().filter((id) => !backend.has(id))).toEqual([]);
	});

	test('newer_version_available can be switched off', () => {
		expect(editorEventIds()).toContain('newer_version_available');
	});
});
