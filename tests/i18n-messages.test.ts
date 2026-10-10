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
 * a value such as a container name. Locales listed in COMPLETE_LOCALES are kept
 * complete by their translators and must have every key.
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
