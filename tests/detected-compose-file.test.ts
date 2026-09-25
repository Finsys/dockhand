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
	expect(component).toContain('Click Save to keep the assignment.');
});

test('detection uses the captured environment and guards selection during environment changes', () => {
	expect(parent).toContain('pathHintEnvId = $currentEnvironment?.id ?? null');
	expect(parent).toMatch(/\{#if mode === 'edit' && pathHintEnvId && \$canAccess\('stacks', 'edit'\)\}\s*<DetectedComposeFile/);
	expect(parent).toMatch(/<DetectedComposeFile\b[^>]*envId=\{pathHintEnvId\}[^>]*disabled=\{loading \|\| saving \|\| pathHintEnvId !== \$currentEnvironment\?\.id\}/);
});

test('null hints skip path validation and display a neutral manual-browse fallback', () => {
	expect(component).toMatch(/const files = data.configFiles;\s*if \(files === null\) \{ return; \}\s*if \(!Array.isArray\(files\)/);
	expect(component).toMatch(/\{:else if !error\}\s*<p role="status" class="text-muted-foreground">Could not detect a Compose file\. You can browse for a file manually\.<\/p>/);
});

test('shared file loading clears previous errors and records HTTP and thrown failures', () => {
	const loader = parent.match(/async function loadFilesFromLocalFilesystem\([\s\S]*?\n\t\}/)?.[0];
	expect(loader).toMatch(/errors.compose = undefined;\s*try/);
	expect(loader).toMatch(/errors.compose = err.error \|\| 'Failed to load compose file';\s*return;/);
	expect(loader).toContain("errors.compose = e instanceof Error ? e.message : 'Failed to load files'");
});

test('DetectedComposeFile compiles as Svelte', () => {
	expect(() => compile(component, { filename: 'DetectedComposeFile.svelte', generate: 'client' })).not.toThrow();
});
