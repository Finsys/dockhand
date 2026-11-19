// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shownEventCount, BACKUP_EVENT_IDS } from '../src/lib/utils/shown-event-count';

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

// A channel added while an environment is being created gets every event the editor
// offers, and its "(N events)" count leaves out the hidden backup group.
describe('EnvironmentModal uses the editor list', () => {
	const modalSrc = readFileSync(join(root, 'src/routes/settings/environments/EnvironmentModal.svelte'), 'utf8');

	test('keeps no event list of its own', () => {
		expect(modalSrc).not.toContain('NOTIFICATION_EVENT_GROUPS');
		expect(modalSrc).not.toMatch(/\{ id: '(container|auto_update|stack)_[a-z_]+', label: '/);
	});

	test('a new channel subscribes to the editor ids', () => {
		expect(modalSrc).toContain('eventTypes: [...ENVIRONMENT_EVENT_IDS] }');
		expect(editorSrc).toContain('export const ENVIRONMENT_EVENT_IDS: string[] = NOTIFICATION_EVENT_GROUPS.flatMap((g) => g.events.map((e) => e.id));');
	});

	test('both channel counts use the shown count', () => {
		expect(modalSrc.match(/shownEventCount\([a-zA-Z]+\.eventTypes, !!\$page\.data\.backupsEnabled\)/g)?.length).toBe(2);
		expect(modalSrc).not.toMatch(/count: [a-zA-Z]+\.eventTypes\.length/);
	});
});

describe('shownEventCount', () => {
	const types = ['container_started', 'backup_success', 'backup_failed', 'restore_success', 'restore_failed', 'stack_deployed'];

	test('counts every subscribed event when backups are on', () => {
		expect(shownEventCount(types, true)).toBe(6);
	});

	test('leaves out the four backup events when their group is hidden', () => {
		expect(shownEventCount(types, false)).toBe(2);
	});

	test('the backup ids are exactly the editor\'s backup group', () => {
		const start = editorSrc.indexOf("id: 'backup',");
		const group = editorSrc.slice(start, editorSrc.indexOf(']', start));
		expect([...group.matchAll(/\{ id: '([a-z_]+)'/g)].map((m) => m[1])).toEqual([...BACKUP_EVENT_IDS]);
	});
});
