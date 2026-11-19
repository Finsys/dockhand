/**
 * While Dockhand replaces a container, the old one is renamed `<name>-old` until the
 * new one runs; GET /api/containers leaves that copy out, so the list and API clients
 * don't show a container that is about to disappear. Only that copy: the same name
 * on another container, or the old container under its own name, stays listed.
 *
 * The callers are checked against the real source, since docker.ts cannot be
 * imported here (better-sqlite3 does not load under the test runner).
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReplacedContainers } from '../src/lib/server/replaced-containers-core';

const ROOT = join(import.meta.dir, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

describe('ReplacedContainers', () => {
	test('leaves out the old copy only while the replacement runs', async () => {
		const t = new ReplacedContainers();
		const old = { id: 'abc', name: 'immich-server-old' };
		await t.whileReplacing('abc', '/immich-server', async () => {
			expect(t.isOldCopy(old)).toBe(true);
		});
		expect(t.isOldCopy(old)).toBe(false);
		expect(t.size()).toBe(0);
	});

	test('keeps the old container under its own name, as before the rename or after a rollback', async () => {
		const t = new ReplacedContainers();
		await t.whileReplacing('abc', 'immich-server', async () => {
			expect(t.isOldCopy({ id: 'abc', name: 'immich-server' })).toBe(false);
		});
	});

	test("never hides a user's own container that happens to be called -old", async () => {
		const t = new ReplacedContainers();
		await t.whileReplacing('abc', 'web', async () => {
			expect(t.isOldCopy({ id: 'other', name: 'web-old' })).toBe(false);
			expect(t.isOldCopy({ id: 'other', name: 'backup-old' })).toBe(false);
		});
	});

	test('lists a copy left behind by a failed replacement once it ends', async () => {
		const t = new ReplacedContainers();
		const failed = t.whileReplacing('abc', 'web', async () => {
			throw new Error('Create failed');
		});
		await expect(failed).rejects.toThrow('Create failed');
		expect(t.isOldCopy({ id: 'abc', name: 'web-old' })).toBe(false);
	});

	test('runs the replacement unmarked when it has no id or name', async () => {
		const t = new ReplacedContainers();
		expect(await t.whileReplacing(undefined, 'web', async () => t.size())).toBe(0);
		expect(await t.whileReplacing('abc', '', async () => t.size())).toBe(0);
	});
});

describe('wiring', () => {
	const docker = read('src', 'lib', 'server', 'docker.ts');

	function body(fn: string): string {
		const start = docker.indexOf(`export async function ${fn}(`);
		expect(start).toBeGreaterThan(-1);
		return docker.slice(start, docker.indexOf('\n}\n', start));
	}

	test('every container replacement that renames to -old is marked', () => {
		const renames = docker.split("encodeURIComponent(name + '-old')").length - 1;
		expect(renames).toBe(2);
		expect(body('recreateContainerFromInspect')).toContain('replacedContainers.whileReplacing(');
		expect(body('updateContainer')).toContain('replacedContainers.whileReplacing(');
	});

	test('GET /api/containers leaves the old copy out', () => {
		expect(read('src', 'routes', 'api', 'containers', '+server.ts')).toContain('!replacedContainers.isOldCopy(c)');
	});
});
