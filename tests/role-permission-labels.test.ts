// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Every permission category needs a display label. A category with none falls back to
// its raw identifier, so the roles UI shows "audit_logs" where it should read
// "Audit log". The two components carry the same map and must not drift apart.
const root = join(import.meta.dir, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const dbSrc = read('src/lib/server/db.ts');
const subTabSrc = read('src/routes/settings/auth/roles/RolesSubTab.svelte');
const modalSrc = read('src/routes/settings/auth/roles/RoleModal.svelte');

/** The categories the backend actually defines, from the Permissions interface. */
function permissionCategories(): string[] {
	const body = dbSrc.match(/export interface Permissions \{([\s\S]*?)\n\}/)?.[1] ?? '';
	return [...body.matchAll(/^\s*([a-z_]+)\s*:/gm)].map((m) => m[1]);
}

/** The categories a component can name, from its categoryLabels map. */
function labelledCategories(src: string): string[] {
	const body = src.match(/const categoryLabels[^\n]*\{([\s\S]*?)\n\t\};/)?.[1] ?? '';
	return [...body.matchAll(/^\s*([a-z_]+)\s*:/gm)].map((m) => m[1]);
}

describe('role permission category labels', () => {
	test('both sources parse a non-trivial list', () => {
		expect(permissionCategories().length).toBeGreaterThan(10);
		expect(labelledCategories(subTabSrc).length).toBeGreaterThan(10);
		expect(labelledCategories(modalSrc).length).toBeGreaterThan(10);
	});

	test('every permission category has a label in the roles list', () => {
		const labelled = new Set(labelledCategories(subTabSrc));
		expect(permissionCategories().filter((c) => !labelled.has(c))).toEqual([]);
	});

	test('every permission category has a label in the role modal', () => {
		const labelled = new Set(labelledCategories(modalSrc));
		expect(permissionCategories().filter((c) => !labelled.has(c))).toEqual([]);
	});

	test('neither map labels a category the backend does not define', () => {
		const defined = new Set(permissionCategories());
		expect(labelledCategories(subTabSrc).filter((c) => !defined.has(c))).toEqual([]);
		expect(labelledCategories(modalSrc).filter((c) => !defined.has(c))).toEqual([]);
	});

	test('the two components agree on the same set of categories', () => {
		expect(labelledCategories(subTabSrc).sort()).toEqual(labelledCategories(modalSrc).sort());
	});

	// The identifiers whose raw spelling would be visibly wrong in the UI.
	test('the categories that read badly as identifiers are labelled', () => {
		const labelled = new Set(labelledCategories(subTabSrc));
		for (const c of ['audit_logs', 'configsets']) expect(labelled.has(c)).toBe(true);
	});
});
