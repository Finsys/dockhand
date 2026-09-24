import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { compile } from 'svelte/compiler';

// Source-level wiring checks, not browser interaction tests.
const component = readFileSync(new URL('../src/routes/stacks/DetectedComposeFile.svelte', import.meta.url), 'utf8');
const parent = readFileSync(new URL('../src/routes/stacks/StackModal.svelte', import.meta.url), 'utf8');

test('detected file only fetches path hints, never posts an assignment', () => {
	expect(component.match(/\/api\/[^?`'"\s]+/g)).toEqual(['/api/stacks/path-hints']);
	expect(component.match(/\bfetch\s*\(/g)).toHaveLength(1);
	expect(component).toMatch(/fetch\(target,\s*\{\s*signal: controller.signal\s*\}\)/);
	expect(component).not.toMatch(/\bPOST\b|adopt-from-labels/);
});

test('selection uses the shared browser callback and explains that Save keeps the assignment', () => {
	expect(component).toContain("await onSelect(path, path.slice(path.lastIndexOf('/') + 1))");
	expect(parent).toMatch(/<DetectedComposeFile\b[^>]*onSelect=\{handleComposeSelect\}/);
	expect(parent).toContain('await proceedWithComposeSelect(path, name)');
	expect(parent).toContain("await loadFilesFromLocalFilesystem(finalPath, workingEnvPath || suggestedEnvPath || '')");
	expect(component).toContain('Click Save to keep the assignment.');
});

test('shared file loading surfaces HTTP and thrown errors to the user', () => {
	const loader = parent.match(/async function loadFilesFromLocalFilesystem\([\s\S]*?\n\t\}/)?.[0];
	expect(loader).toContain("errors.compose = err.error || 'Failed to load compose file'");
	expect(loader).toContain("errors.compose = e instanceof Error ? e.message : 'Failed to load files'");
	const visibleError = parent.match(/\{#if errors\.compose\}[\s\S]*?\{errors\.compose\}[\s\S]*?\{\/if\}/);
	expect(visibleError).not.toBeNull();
});

test('DetectedComposeFile compiles as Svelte', () => {
	expect(() => compile(component, { filename: 'DetectedComposeFile.svelte', generate: 'client' })).not.toThrow();
});
