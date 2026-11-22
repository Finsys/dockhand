/**
 * Where a compose variable reference starts. Expectations follow `docker compose config`
 * (Compose v5.5, X=SALT): `$$2b$$12$$${X:?}` interpolates, `$$prefix$${X}` and `$$$${X}`
 * stay literal, `$$$X` interpolates.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { REF_START, BARE_REF_START, extractComposeVars } from '../src/lib/utils/compose-var-ref';

const braced = (name: string) => new RegExp(`${REF_START}\\{${name}(?::?[-?+][^}]*)?\\}`);
const bare = (name: string) => new RegExp(`${BARE_REF_START}${name}(?![a-zA-Z0-9_])`);

describe('REF_START', () => {
	test.each([
		['${X}', true],
		['${X:?}', true],
		['$$2b$$12$$${X:?}', true],
		['$$${X}', true],
		['a$$$$${X:-d}', true],
		['a$$$$$${X:-d}', false],
		['$${X}', false],
		['$$$${X}', false],
		['$$prefix$${X}', false]
	])('%s -> reference %p', (text, expected) => {
		expect(braced('X').test(text)).toBe(expected);
	});

	test('the match ends at the closing brace, where the editor puts its badge', () => {
		const re = new RegExp(`${REF_START}\\{X\\}`, 'g');
		const m = re.exec('A=$$2b$$${X} tail')!;
		expect(m.index + m[0].length).toBe('A=$$2b$$${X}'.length);
	});
});

describe('BARE_REF_START', () => {
	test.each([
		['$X', true],
		['$$$X', true],
		['$$$$$X', true],
		['$$X', false],
		['$$$$X', false],
		['1$X', false]
	])('%s -> reference %p', (text, expected) => {
		expect(bare('X').test(text)).toBe(expected);
	});
});

describe('the compose editor and env validation use it', () => {
	const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

	test('no reference pattern keeps the plain $-lookbehind', () => {
		for (const f of ['src/lib/components/CodeEditor.svelte', 'src/lib/utils/compose-var-ref.ts']) {
			const src = strip(readFileSync(f, 'utf8'));
			expect(`${f}: ${src.includes('(?<!\\\\$)\\\\$') || src.includes('(?<!\\$)\\$')}`).toBe(`${f}: false`);
		}
		const editor = strip(readFileSync('src/lib/components/CodeEditor.svelte', 'utf8'));
		expect(editor).toContain("import { REF_START, BARE_REF_START } from '$lib/utils/compose-var-ref';");
		expect(editor).not.toMatch(/\b(const|let|var)\s+(BARE_)?REF_START\b/);
		// 7 value-badge patterns + 7 gutter patterns, and the bare $NAME gutter pattern.
		expect(editor.split('${REF_START}\\\\{${marker.name}').length - 1).toBe(14);
		expect(editor.split('${BARE_REF_START}${marker.name}').length - 1).toBe(1);
		const route = strip(readFileSync('src/routes/api/stacks/[name]/env/validate/+server.ts', 'utf8'));
		expect(route).toContain("import { extractComposeVars } from '$lib/utils/compose-var-ref';");
		expect(route).not.toMatch(/(function|const|let)\s+extractComposeVars\b/);
		expect(route).toContain('extractComposeVars(composeContent)');
		expect(route).not.toContain('(?<!');
	});
});

// Compose substitutes ${VAR-d}, ${VAR:-d}, ${VAR+x} and ${VAR:+x} without VAR; ${VAR:?e} and
// ${VAR?e} fail the deploy when it is unset.
describe('extractComposeVars', () => {
	test.each([
		['${A}', ['A'], []],
		['$A', ['A'], []],
		['${A:?err}', ['A'], []],
		['${A?err}', ['A'], []],
		['${A:?}', ['A'], []],
		['${A:-d}', [], ['A']],
		['${A-d}', [], ['A']],
		['${A:+x}', [], ['A']],
		['${A+x}', [], ['A']],
		['$$2b$$12$$${A:?}', ['A'], []],
		['$${A}', [], []],
		['# ${A}', [], []]
	])('%s', (yaml, required, optional) => {
		expect(extractComposeVars(yaml)).toEqual({ required, optional });
	});

	test('an indented comment is skipped and several names come back sorted', () => {
		expect(extractComposeVars('  # ${A}\nx: ${C} ${B:-d} $D ${E?e}')).toEqual({ required: ['C', 'D', 'E'], optional: ['B'] });
	});

	test('a bare $VAR is required even after an optional ${VAR:-d}', () => {
		expect(extractComposeVars('x: ${A:-d}\ny: $A')).toEqual({ required: ['A'], optional: [] });
		expect(extractComposeVars('x: $A\ny: ${A:-d}')).toEqual({ required: ['A'], optional: [] });
	});

	test('a required use anywhere wins over an optional one', () => {
		expect(extractComposeVars('x: ${A:-d}\ny: ${A:?set A}')).toEqual({ required: ['A'], optional: [] });
		expect(extractComposeVars('x: ${A:?set A}\ny: ${A:-d}')).toEqual({ required: ['A'], optional: [] });
	});
});
