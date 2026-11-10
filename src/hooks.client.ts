/**
 * Decide the interface language before the first message renders.
 *
 * Paraglide resolves the locale on the first `m.*()` call and, with its own cookie
 * or localStorage strategies, writes the result straight back - which would freeze
 * whatever the browser negotiated and leave its language setting with no effect
 * ever after. Overwriting the getter keeps the decision here: the stored choice
 * when there is one, the browser otherwise.
 *
 * The decision itself lives in `makeLocaleGetter` so it can be tested; this file
 * is only the wiring.
 */
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import { LOCALE_STORAGE_KEY, makeLocaleGetter, restoreServerLocale } from '$lib/i18n/locale-preference';

const getLocale = makeLocaleGetter(
	() => localStorage.getItem(LOCALE_STORAGE_KEY),
	() => navigator.languages ?? [navigator.language]
);

overwriteGetLocale(getLocale as never);

/** Before the app starts: bring back the language the server keeps for this user or install. */
export async function init() {
	let store: Storage;
	try {
		store = localStorage;
	} catch {
		return; // A blocked store: the browser's language decides.
	}
	await restoreServerLocale(fetch, store);
}
