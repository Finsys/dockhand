/**
 * The cronstrue locale for each UI locale. The imports register cronstrue's own
 * translations; a UI locale missing here falls back to English.
 */
import 'cronstrue/locales/de';
import 'cronstrue/locales/es';
import 'cronstrue/locales/fr';
import 'cronstrue/locales/pl';
import 'cronstrue/locales/ru';
import 'cronstrue/locales/zh_CN';

const CRONSTRUE_LOCALES: Record<string, string> = {
	de: 'de',
	'es-ES': 'es',
	'fr-FR': 'fr',
	'fr-CA': 'fr',
	pl: 'pl',
	'zh-CN': 'zh_CN',
	ru: 'ru'
};

export function cronstrueLocaleFor(locale: string): string {
	return CRONSTRUE_LOCALES[locale] ?? 'en';
}
