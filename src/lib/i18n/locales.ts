/**
 * The locales this build carries, and the one English falls back to.
 *
 * A copy of project.inlang/settings.json, which is what paraglide compiles from.
 * It is duplicated here rather than imported because that file lives outside src/,
 * where Vite will not serve it to the dev server, and because the generated
 * paraglide runtime does not exist in a fresh checkout - which is where the unit
 * tests run. A test asserts this list still matches the settings file.
 */
export const LOCALES = ['en', 'de', 'fr-FR', 'fr-CA', 'pl', 'zh-CN'] as const;
export const BASE_LOCALE = 'en';
