import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The boot screen in app.html must paint each dark theme's OWN background before app.css loads,
// so its inline darkBg map has to match the .dark / .dark.theme-dark-* --background rules in app.css.
// This test fails if a theme is added, removed, or recolored in app.css without updating app.html.

const root = join(import.meta.dir, '..');
const css = readFileSync(join(root, 'src/app.css'), 'utf8');
const html = readFileSync(join(root, 'src/app.html'), 'utf8');

function cssDarkBackgrounds(): Record<string, string> {
	const out: Record<string, string> = {};
	// default dark: the `.dark { ... }` block (not .dark.theme-dark-*)
	const def = css.match(/\.dark\s*\{([^}]*)\}/);
	const defBg = def && def[1].match(/--background:\s*([^;]+);/);
	if (defBg) out['default'] = defBg[1].trim();
	for (const m of css.matchAll(/\.dark\.theme-dark-([a-z0-9-]+)\s*\{([^}]*)\}/g)) {
		const bg = m[2].match(/--background:\s*([^;]+);/);
		if (bg) out[m[1]] = bg[1].trim();
	}
	return out;
}

function htmlBootMap(): Record<string, string> {
	// Extract the object literal assigned to `var darkBg = { ... };`
	const block = html.match(/var darkBg = \{([\s\S]*?)\};/);
	if (!block) throw new Error('darkBg map not found in app.html');
	const out: Record<string, string> = {};
	for (const m of block[1].matchAll(/'([a-z0-9-]+)':\s*'([^']+)'/g)) out[m[1]] = m[2];
	return out;
}

describe('app-boot dark theme backgrounds', () => {
	const cssMap = cssDarkBackgrounds();
	const bootMap = htmlBootMap();

	it('app.css defines a default dark background and several themed ones', () => {
		expect(cssMap['default']).toBeDefined();
		expect(Object.keys(cssMap).length).toBeGreaterThan(10);
	});

	it('every dark theme with its own background in app.css is in the boot map, with the same value', () => {
		for (const [id, bg] of Object.entries(cssMap)) {
			expect(bootMap[id], `boot map missing theme "${id}"`).toBe(bg);
		}
	});

	it('the boot map has no stale theme that app.css no longer defines', () => {
		for (const id of Object.keys(bootMap)) {
			expect(cssMap[id], `boot map has stale theme "${id}" not in app.css`).toBeDefined();
		}
	});
});
