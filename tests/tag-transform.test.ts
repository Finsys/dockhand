// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, it, expect } from 'bun:test';
import { compileTagTransform, applyTagTransform, tagTransformFromLabels } from '../src/lib/server/semver/tag-transform';
import { findNewerVersionTag } from '../src/lib/server/semver/find-newer';

describe('compileTagTransform / applyTagTransform', () => {
	// A linuxserver-style revision formula: 2.2.0-r2-ls366 -> 2.2.0-2.
	const FORMULA = '^(\\d+\\.\\d+\\.\\d+)-r(\\d+).*$ => $1-$2';

	it('rewrites a tag by the formula', () => {
		const t = compileTagTransform(FORMULA)!;
		expect(applyTagTransform(t, '2.2.0-r2-ls366')).toBe('2.2.0-2');
		expect(applyTagTransform(t, '2.2.0-r3-ls370')).toBe('2.2.0-3');
	});

	it('leaves a non-matching tag unchanged', () => {
		const t = compileTagTransform(FORMULA)!;
		expect(applyTagTransform(t, 'latest')).toBe('latest');
		expect(applyTagTransform(t, '3.0.0-alpine')).toBe('3.0.0-alpine');
	});

	it('substitutes an absent optional group with empty, never the literal "undefined"', () => {
		const t = compileTagTransform('^(\\d+)(?:-(r\\d+))?$ => $1$2')!;
		expect(applyTagTransform(t, '5')).toBe('5');
		expect(applyTagTransform(t, '5-r2')).toBe('5r2');
	});

	it('is null for an absent, arrowless, or half-empty formula', () => {
		expect(compileTagTransform(undefined)).toBeNull();
		expect(compileTagTransform('')).toBeNull();
		expect(compileTagTransform('no arrow here')).toBeNull();
		expect(compileTagTransform('^x$ => ')).toBeNull();
		expect(compileTagTransform(' => $1')).toBeNull();
	});

	it('rejects an unsafe/ReDoS regex half (degrades to no transform)', () => {
		expect(compileTagTransform('(a+)+$ => $1')).toBeNull();
		expect(compileTagTransform('(a|a)+$ => $1')).toBeNull();
		expect(compileTagTransform(`${'a'.repeat(400)} => $1`)).toBeNull();
		expect(compileTagTransform('( => $1')).toBeNull(); // unterminated group -> new RegExp throws
	});

	it('reads the label, native key winning over the wud.* spellings', () => {
		expect(tagTransformFromLabels({ 'wud.tag.transform': FORMULA })?.replacement).toBe('$1-$2');
		expect(tagTransformFromLabels({ 'getwud.app/tag.transform': FORMULA })).not.toBeNull();
		expect(tagTransformFromLabels({})).toBeNull();
		expect(tagTransformFromLabels(null)).toBeNull();
	});

	it('end to end: a transform makes a -rN bump offerable through findNewerVersionTag', () => {
		const t = compileTagTransform(FORMULA);
		const r = findNewerVersionTag('2.2.0-r2-ls366', ['2.2.0-r2-ls366', '2.2.0-r3-ls370'], {
			matchFlavor: true,
			tagTransform: t
		});
		// The ORIGINAL tag is offered, not the transformed one.
		expect(r?.tag).toBe('2.2.0-r3-ls370');
	});
});
