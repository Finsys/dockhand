import { describe, test, expect } from 'bun:test';
import cronstrue from 'cronstrue';
import { cronstrueLocaleFor } from '../src/lib/i18n/cron-core';
import { LOCALES, BASE_LOCALE } from '../src/lib/i18n/locales';

describe('cronstrueLocaleFor', () => {
	const english = cronstrue.toString('0 5 * * 1', { locale: 'en' });

	for (const locale of LOCALES.filter((l) => l !== BASE_LOCALE)) {
		test(`${locale} describes a cron expression in its own language`, () => {
			const cl = cronstrueLocaleFor(locale);
			expect(cl).not.toBe('en');
			expect(cronstrue.toString('0 5 * * 1', { locale: cl })).not.toBe(english);
		});
	}

	test('an unknown locale falls back to English', () => {
		expect(cronstrueLocaleFor('xx')).toBe('en');
	});
});
