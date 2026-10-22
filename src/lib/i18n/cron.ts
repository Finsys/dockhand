/**
 * cronstrue (the human-readable cron description) in the UI language.
 * The imports register cronstrue's own translations; other UI locales fall back to English.
 */
import 'cronstrue/locales/de';
import 'cronstrue/locales/fr';
import 'cronstrue/locales/pl';
import 'cronstrue/locales/zh_CN';
import { getLocale } from '$lib/paraglide/runtime.js';

const CRONSTRUE_LOCALES: Record<string, string> = {
	de: 'de',
	'fr-FR': 'fr',
	'fr-CA': 'fr',
	pl: 'pl',
	'zh-CN': 'zh_CN'
};

export function cronstrueLocale(): string {
	return CRONSTRUE_LOCALES[getLocale()] ?? 'en';
}
