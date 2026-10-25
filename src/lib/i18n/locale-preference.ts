/**
 * Which language the interface speaks, and where that choice lives.
 *
 * Paraglide decides the locale the first time a message renders, so the choice is
 * read synchronously from localStorage. The server keeps it too (per user with
 * auth, for the install without). The client init hook copies it into localStorage
 * before the first render, and the root layout does it once the signed-in user is
 * known (the sign-in page cannot read it), so a browser that clears its storage on
 * close still gets it back.
 *
 * Paraglide's own `cookie` and `localStorage` strategies cannot be used for this:
 * its `getLocale()` writes the resolved locale back through `setLocale()` on first
 * read, so merely opening the page would freeze whatever the browser negotiated
 * and the browser's own language setting would stop having any effect.
 *
 * The locale list comes from ./locales rather than the generated paraglide runtime,
 * which is a build artefact absent in a fresh checkout - where the unit tests run.
 */
import { LOCALES, BASE_LOCALE } from './locales';

const locales = LOCALES as readonly string[];
const baseLocale = BASE_LOCALE;

export const LOCALE_STORAGE_KEY = 'dockhand-language';

/**
 * The picker's value for "no choice". Never stored - choosing it REMOVES the key,
 * because an absent choice is what lets Accept-Language keep deciding.
 */
export const FOLLOW_BROWSER = 'browser';

export type Locale = string;

/** The locale if it is one this build carries, otherwise undefined. */
export function asLocale(value: unknown): Locale | undefined {
	return typeof value === 'string' && locales.includes(value)
		? (value as Locale)
		: undefined;
}

/** What the browser asks for, narrowed to a locale this build carries. */
export function fromNavigator(languages: readonly string[]): Locale | undefined {
	for (const tag of languages) {
		// An exact match wins (zh-CN over zh), then the bare language (de-AT -> de).
		const exact = asLocale(tag);
		if (exact) return exact;
		const bare = asLocale(tag.split('-')[0]);
		if (bare) return bare;
	}
	return undefined;
}

/**
 * The locale to render with: the stored choice, else the browser's preference,
 * else the base locale. `stored` is undefined when nobody has chosen yet - that
 * is what keeps the browser setting live until somebody does.
 */
export function resolveLocale(stored: unknown, languages: readonly string[]): Locale {
	return asLocale(stored) ?? fromNavigator(languages) ?? (baseLocale as Locale);
}

/**
 * The locale getter paraglide renders with, resolved ONCE: the value must not
 * change under a rendered page, and the picker reloads after storing a new one.
 * Reading the store is injected so a blocked one (private mode) degrades to the
 * browser's preference rather than throwing out of the first render.
 */
export function makeLocaleGetter(
	readStored: () => string | null,
	languages: () => readonly string[]
): () => Locale {
	let resolved: Locale | undefined;
	return () => {
		if (!resolved) {
			let stored: string | null = null;
			try {
				stored = readStored();
			} catch {
				// A blocked store says nothing about the language; the browser still does.
			}
			resolved = resolveLocale(stored, languages());
		}
		return resolved;
	};
}

export const LANGUAGE_PREFERENCE_URL = '/api/preferences/language';

/**
 * The language the server keeps for this user or install: a locale, null when none is
 * chosen, or undefined when it could not say (signed out, offline, too slow). Gives up
 * after `timeoutMs` so a slow server never holds the first render for long.
 */
export async function fetchServerLocale(fetchFn: typeof fetch, timeoutMs = 1500): Promise<Locale | null | undefined> {
	try {
		const res = await fetchFn(LANGUAGE_PREFERENCE_URL, { signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) return undefined;
		const data = await res.json();
		return data?.language === null ? null : asLocale(data?.language);
	} catch {
		return undefined;
	}
}

/**
 * What localStorage should hold once the server answered: its choice wins, since it
 * follows the user across browsers. No server choice leaves the local one alone, so a
 * choice made before the server kept it is not lost.
 */
export function storedAfterServer(server: Locale | null | undefined, local: string | null): string | null {
	return server ?? local;
}

/**
 * The locale to switch to once the signed-in user is known: the server's choice when it
 * differs from the one rendered, otherwise null. Signing in does not reload the page, so
 * the locale picked before the user was known can be the wrong one.
 */
export function localeToApply(server: Locale | null | undefined, rendered: Locale): Locale | null {
	return server && server !== rendered ? server : null;
}

type LocaleStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Before the first render: copy the server's language into the store. Never throws. */
export async function restoreServerLocale(fetchFn: typeof fetch, store: LocaleStore): Promise<void> {
	const server = await fetchServerLocale(fetchFn);
	try {
		const next = storedAfterServer(server, store.getItem(LOCALE_STORAGE_KEY));
		if (next) store.setItem(LOCALE_STORAGE_KEY, next);
	} catch {
		// A blocked store: the browser's language decides.
	}
}

/** The user whose language still has to be checked, or undefined when there is none. */
export function signedInUserToCheck(
	auth: { loading: boolean; authEnabled: boolean; user: { id: number } | null | undefined },
	checkedFor: number | undefined
): number | undefined {
	if (auth.loading || !auth.authEnabled || !auth.user || auth.user.id === checkedFor) return undefined;
	return auth.user.id;
}

/** After sign-in: switch to the server's language with one reload when it differs from the rendered one. */
export async function applySignedInLocale(
	fetchFn: typeof fetch,
	rendered: Locale,
	store: LocaleStore,
	reload: () => void
): Promise<void> {
	const next = localeToApply(await fetchServerLocale(fetchFn), rendered);
	if (!next) return;
	try {
		store.setItem(LOCALE_STORAGE_KEY, next);
	} catch {
		return; // a blocked store would reload forever
	}
	reload();
}

export type ChooseResult = 'saved' | 'failed' | 'blocked' | 'ignored';

/**
 * Store a picked language: on the server first, since its copy wins on the next load and a
 * failed save must not leave a local choice that the reload would undo; then locally, then
 * reload. A request that errors or times out is checked once more with a GET, because the
 * server may have saved it anyway.
 */
export async function chooseLanguage(
	value: string,
	fetchFn: typeof fetch,
	store: LocaleStore,
	reload: () => void,
	timeoutMs = 5000
): Promise<ChooseResult> {
	const language = value === FOLLOW_BROWSER ? null : asLocale(value);
	if (language === undefined) return 'ignored';
	let saved = false;
	try {
		const res = await fetchFn(LANGUAGE_PREFERENCE_URL, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ language }),
			signal: AbortSignal.timeout(timeoutMs)
		});
		saved = res.ok;
	} catch {
		saved = (await fetchServerLocale(fetchFn)) === language;
	}
	if (!saved) return 'failed';
	try {
		// An absent key, not a marker, is what hands the decision back to Accept-Language.
		if (language === null) store.removeItem(LOCALE_STORAGE_KEY);
		else store.setItem(LOCALE_STORAGE_KEY, language);
	} catch {
		return 'blocked';
	}
	reload();
	return 'saved';
}
