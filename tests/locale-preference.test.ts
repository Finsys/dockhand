/**
 * Which language the interface speaks.
 *
 * The browser's own setting has to keep working until somebody chooses a language,
 * and a chosen one has to survive the browser changing its mind. Those two pull in
 * opposite directions, which is what these cases pin.
 */
import { describe, test, expect } from 'bun:test';
import {
	asLocale,
	fromNavigator,
	resolveLocale,
	makeLocaleGetter,
	FOLLOW_BROWSER
} from '../src/lib/i18n/locale-preference';

describe('asLocale', () => {
	test('accepts a locale this build carries', () => {
		expect(asLocale('pl')).toBe('pl');
		expect(asLocale('zh-CN')).toBe('zh-CN');
	});

	test('refuses anything else, so a stale or hand-edited value cannot take effect', () => {
		for (const bad of ['xx', 'PL', 'zh', '', 'en-US', null, undefined, 42, {}]) {
			expect(asLocale(bad)).toBeUndefined();
		}
	});
});

describe('FOLLOW_BROWSER', () => {
	test('is not a locale, so storing it could never be mistaken for a choice', () => {
		// The picker uses it as a value; asLocale must refuse it, and choosing it
		// removes the stored key rather than writing this string.
		expect(asLocale(FOLLOW_BROWSER)).toBeUndefined();
	});

	test('resolving it falls through to the browser, as an absent choice does', () => {
		expect(resolveLocale(FOLLOW_BROWSER, ['de'])).toBe('de');
	});
});

describe('fromNavigator', () => {
	test('takes the first language the build carries, not the first listed', () => {
		expect(fromNavigator(['xx', 'ja', 'de'])).toBe('de');
	});

	test('falls back from a region to the bare language', () => {
		expect(fromNavigator(['de-AT'])).toBe('de');
	});

	test('prefers an exact region match over the bare language', () => {
		// zh-CN is carried; a bare zh is not, so the order matters.
		expect(fromNavigator(['zh-CN'])).toBe('zh-CN');
	});

	test('a region whose bare language is carried still resolves', () => {
		expect(fromNavigator(['pl-PL'])).toBe('pl');
	});

	test('fr-CA is taken as itself rather than collapsing to fr-FR', () => {
		expect(fromNavigator(['fr-CA'])).toBe('fr-CA');
	});

	test('gives up when nothing matches', () => {
		expect(fromNavigator(['ja', 'ko'])).toBeUndefined();
		expect(fromNavigator([])).toBeUndefined();
	});
});

describe('resolveLocale', () => {
	test('a stored choice wins over the browser', () => {
		expect(resolveLocale('de', ['pl'])).toBe('de');
	});

	test('with nothing stored the browser decides, so changing it still works', () => {
		// The regression this guards: a stored value written automatically on first
		// load would pin the language and the browser setting would stop mattering.
		expect(resolveLocale(undefined, ['de'])).toBe('de');
		expect(resolveLocale(null, ['pl'])).toBe('pl');
	});

	test('a stored value this build does not carry is ignored, not rendered', () => {
		expect(resolveLocale('xx', ['pl'])).toBe('pl');
	});

	test('falls back to English when neither says anything usable', () => {
		expect(resolveLocale(undefined, ['ja'])).toBe('en');
		expect(resolveLocale(undefined, [])).toBe('en');
	});
});

describe('makeLocaleGetter', () => {
	test('renders the stored choice, not what the browser asked for', () => {
		const get = makeLocaleGetter(
			() => 'de',
			() => ['pl']
		);
		expect(get()).toBe('de');
	});

	test('follows the browser while nobody has chosen', () => {
		const get = makeLocaleGetter(
			() => null,
			() => ['pl', 'en']
		);
		expect(get()).toBe('pl');
	});

	test('resolves once, so the language cannot change under a rendered page', () => {
		let current: string | null = 'de';
		let reads = 0;
		const get = makeLocaleGetter(
			() => {
				reads++;
				return current;
			},
			() => ['pl']
		);

		expect(get()).toBe('de');
		current = 'pl';
		expect(get()).toBe('de');
		expect(reads).toBe(1);
	});

	test('a blocked store leaves the browser preference, instead of throwing mid-render', () => {
		const get = makeLocaleGetter(
			() => {
				throw new Error('storage blocked');
			},
			() => ['de']
		);
		expect(get()).toBe('de');
	});

	test('a stale stored locale this build dropped falls back to the browser', () => {
		const get = makeLocaleGetter(
			() => 'xx',
			() => ['pl']
		);
		expect(get()).toBe('pl');
	});
});
