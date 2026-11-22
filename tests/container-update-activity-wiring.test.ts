// Every Dockhand path that recreates a container to update it records an 'update' row on
// the Activity page through recordContainerUpdateActivity: Docker emits no event for it.
// The scheduled and batch path is exercised end to end by the release-age probe; the
// container view's Update goes through its own endpoint, whose module cannot be imported
// here (it pulls in the database), so that wiring is read from the source.
// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (...p: string[]) =>
	readFileSync(join(import.meta.dir, '..', ...p), 'utf8')
		.split('\n')
		.filter((l) => !l.trim().startsWith('//'))
		.join('\n');

describe('container update activity', () => {
	test('the single update endpoint records it after a successful update, for the new container', () => {
		const code = read('src', 'routes', 'api', 'containers', '[id]', 'update', '+server.ts');
		const update = code.indexOf('const container = await updateContainer(');
		const record = code.indexOf('await recordContainerUpdateActivity({');
		const ok = code.indexOf('return json({ warnings, success: true');
		expect(update).toBeGreaterThan(-1);
		expect(record).toBeGreaterThan(update);
		expect(ok).toBeGreaterThan(record);
		expect(code.slice(record, ok)).toMatch(/envId: envIdNum,\s*containerId: container\.id,/);
	});

	test('recreateContainer records it through the same helper', () => {
		const code = read('src', 'lib', 'server', 'scheduler', 'tasks', 'container-update.ts');
		expect(code).toMatch(/await recordContainerUpdateActivity\(\{\s*envId,\s*containerId: newContainerId \|\| oldParentId,/);
	});

	test('the helper honours the environment activity setting and emits to live listeners', () => {
		const code = read('src', 'lib', 'server', 'scheduler', 'tasks', 'container-update.ts');
		const start = code.indexOf('export async function recordContainerUpdateActivity(');
		const body = code.slice(start, code.indexOf('export async function recreateContainer(', start));
		expect(body).toContain("if (env?.collectActivity === false) return null;");
		expect(body).toContain("action: 'update',");
		expect(body).toContain("if (savedEvent) containerEventEmitter.emit('event', savedEvent);");
	});
});
