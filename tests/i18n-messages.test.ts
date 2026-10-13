import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * UI translations (Paraglide, src/lib/i18n/messages).
 *
 * English is the source. A key missing in another locale falls back to English,
 * so a translation may follow an area later - but a locale must never carry keys
 * English does not have, or other placeholders, otherwise a message silently drops
 * a value such as a container name.
 *
 * COMPLETE_LOCALES must have every key. Only German is listed: the contributor who
 * adds an area adds its German with it, so the two cannot drift apart. The other
 * languages are translated by somebody else in a later pass, and holding their keys
 * against the person adding the area would block a complete contribution on work
 * that is not theirs.
 *
 * Every locale is complete as of the settings pages, but listing the rest here would
 * fail the build on the very PR that adds an area in English and German, before the
 * other translations arrive - so a locale is added only alongside a translator who
 * keeps it complete as each area lands.
 */

const COMPLETE_LOCALES = ['de'];

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MESSAGES = join(ROOT, 'src/lib/i18n/messages');
const settings = JSON.parse(readFileSync(join(ROOT, 'project.inlang/settings.json'), 'utf8'));

type Message = string | Array<{ declarations?: string[]; match: Record<string, string> }>;

function load(locale: string): Record<string, Message> {
	const { $schema: _schema, ...messages } = JSON.parse(readFileSync(join(MESSAGES, `${locale}.json`), 'utf8'));
	return messages;
}

/** Placeholder names a message uses, across all of its variants. */
function placeholders(message: Message): string[] {
	const texts = typeof message === 'string' ? [message] : message.flatMap((m) => Object.values(m.match));
	const names = new Set<string>();
	for (const text of texts) {
		for (const match of text.matchAll(/(?<!\\)\{([a-zA-Z_][\w]*)\}/g)) names.add(match[1]);
	}
	return [...names].sort();
}

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return name === 'paraglide' ? [] : sourceFiles(path);
		return /\.(svelte|ts)$/.test(name) ? [path] : [];
	});
}

const base = load(settings.baseLocale);

describe('UI translations', () => {
	test('English is the base locale and every complete locale is configured', () => {
		expect(settings.baseLocale).toBe('en');
		for (const locale of COMPLETE_LOCALES) expect(settings.locales).toContain(locale);
	});

	test('the locale strategy is the same in the build config and the compile script', () => {
		// Declared twice: the vite plugin builds with one, `npm run i18n:compile` with the
		// other. Paraglide tree-shakes away any strategy its own invocation does not name,
		// so the two compiling to different runtimes is a difference nothing else reports.
		const vite = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
		const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

		const fromVite = vite.match(/strategy:\s*\[([^\]]+)\]/)?.[1];
		expect(fromVite).toBeDefined();
		const viteList = [...(fromVite as string).matchAll(/'([^']+)'/g)].map((m) => m[1]);

		const flag = (pkg.scripts['i18n:compile'] as string).match(/--strategy\s+([^-]+?)\s+--/)?.[1];
		expect(flag).toBeDefined();
		const scriptList = (flag as string).trim().split(/\s+/);

		expect(scriptList).toEqual(viteList);
		// The language is decided in hooks.client.ts instead: paraglide's own cookie and
		// localStorage strategies write the resolved locale back on first read, which
		// pins whatever the browser negotiated and ignores it from then on.
		expect(viteList).not.toContain('cookie');
		expect(viteList).not.toContain('localStorage');
	});

	test('the language picker names the browser it would follow', () => {
		// The "follow the browser" option says which language that currently means, so
		// the placeholder has to survive translation in every locale.
		for (const locale of settings.locales) {
			const messages = load(locale);
			const follow = messages['language_follow_browser'];
			if (follow === undefined) continue;
			expect(placeholders(follow)).toEqual(['language']);
		}
	});

	test('message keys are snake_case with an area prefix', () => {
		const invalid = Object.keys(base).filter((key) => !/^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(key));
		expect(invalid).toEqual([]);
	});

	test('no message is empty', () => {
		for (const locale of settings.locales) {
			const empty = Object.entries(load(locale))
				.filter(([, message]) =>
					(typeof message === 'string' ? [message] : message.flatMap((m) => Object.values(m.match))).some(
						(text) => text.trim() === ''
					)
				)
				.map(([key]) => key);
			expect({ locale, empty }).toEqual({ locale, empty: [] });
		}
	});

	test('every placeholder of a plural or variant message is declared', () => {
		// A variant should declare each variable it uses ('input x' or 'local x = ...'), as English
		// does. Paraglide still fills in an undeclared one, so a missing declaration is easy to miss.
		for (const locale of settings.locales) {
			const undeclared = Object.entries(load(locale)).flatMap(([key, message]) =>
				typeof message === 'string'
					? []
					: message.flatMap((variant) => {
							const declared = (variant.declarations ?? []).map((d) => /^(?:input|local)\s+(\w+)/.exec(d)?.[1]);
							return placeholders([variant])
								.filter((name) => !declared.includes(name))
								.map((name) => `${key}: ${name}`);
						})
			);
			expect({ locale, undeclared }).toEqual({ locale, undeclared: [] });
		}
	});

	test('the locale list the app imports matches the inlang settings', () => {
		// src/lib/i18n/locales.ts restates what paraglide compiles from, because the
		// settings file sits outside src/ and the generated runtime does not exist in a
		// fresh checkout. Restating it is only safe while something fails when it drifts.
		const src = readFileSync(join(ROOT, 'src/lib/i18n/locales.ts'), 'utf8');
		const listed = [...(src.match(/LOCALES = \[([^\]]+)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(
			(m) => m[1]
		);
		const base = src.match(/BASE_LOCALE = '([^']+)'/)?.[1];
		expect(listed).toEqual(settings.locales);
		expect(base).toBe(settings.baseLocale);
	});

	for (const locale of settings.locales.filter((l: string) => l !== settings.baseLocale)) {
		test(`${locale} has no keys that English does not have`, () => {
			const extra = Object.keys(load(locale)).filter((key) => !(key in base));
			expect(extra).toEqual([]);
		});

		if (COMPLETE_LOCALES.includes(locale)) {
			test(`${locale} has every key of English`, () => {
				const messages = load(locale);
				const missing = Object.keys(base).filter((key) => !(key in messages));
				expect(missing).toEqual([]);
			});
		}

		test(`${locale} uses the same placeholders as English`, () => {
			const messages = load(locale);
			const differing = Object.keys(base)
				.filter((key) => key in messages)
				.filter((key) => placeholders(base[key]).join() !== placeholders(messages[key]).join());
			expect(differing).toEqual([]);
		});
	}

	// The Psono note is assembled from fragments around the <strong>/<code> spans it
	// highlights, and the markup emits no whitespace between them: a CJK locale runs its
	// comma straight onto the label, while a western one needs a space. So each fragment
	// carries its own spacing, and only the assembled string can show it is right.
	describe('the Psono note assembles with correct spacing', () => {
		const CODE = 'psono://<secret-id>/<field>';
		const PARTS = ['before', 'api_keys', 'with', 'restrict', 'on_and', 'insecure', 'off'];
		// Fullwidth and CJK punctuation, plus the ASCII marks a fragment may open with.
		const OPENS_WITH_PUNCTUATION = /^[,.;:!?\u3000-\u303f\uff00-\uffef]/;

		for (const locale of settings.locales) {
			test(locale, () => {
				const messages = load(locale);
				const part = (name: string) => messages[`settings_secrets_psono_note_${name}`] as string;
				const pieces = [...PARTS.map(part), CODE, part('after')];
				const rendered = pieces.join('');

				// Every seam needs a separator, or two words fuse into one. A fragment that
				// opens with punctuation is the exception - that is what must NOT be spaced.
				for (let i = 1; i < pieces.length; i++) {
					const seam = `${pieces[i - 1]} | ${pieces[i]}`;
					const separated = pieces[i - 1].endsWith(' ') || pieces[i].startsWith(' ');
					expect({ seam, separated }).toEqual({
						seam,
						separated: !OPENS_WITH_PUNCTUATION.test(pieces[i])
					});
				}

				// And a separator must be exactly one space, never doubled or before a mark.
				expect(rendered).not.toContain('  ');
				expect(rendered).not.toMatch(/ [,.;:!?]/);
				expect(rendered).not.toMatch(/ [\u3000-\u303f\uff00-\uffef]/);
			});
		}
	});

	test('every message used in the code exists', () => {
		const used = new Set<string>();
		for (const file of sourceFiles(join(ROOT, 'src'))) {
			const text = readFileSync(file, 'utf8');
			if (!text.includes('$lib/paraglide/messages')) continue;
			// Messages are always called with a prefixed key (m.area_key()); a local `m` such as
			// `.map((m) => m.cpu_percent)` or a `Map` named `m` (m.get()) is not a message
			for (const match of text.matchAll(/\bm\.([a-z][a-z0-9]*_[a-z0-9_]+)\(/g)) used.add(match[1]);
		}
		const unknown = [...used].filter((key) => !(key in base));
		expect(unknown).toEqual([]);
	});
});
