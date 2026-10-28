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
	fetchServerLocale,
	storedAfterServer,
	localeToApply,
	restoreServerLocale,
	signedInUserToCheck,
	applySignedInLocale,
	chooseLanguage,
	LOCALE_STORAGE_KEY,
	LANGUAGE_PREFERENCE_URL,
	FOLLOW_BROWSER
} from '../src/lib/i18n/locale-preference';

describe('asLocale', () => {
	test('accepts a locale this build carries', () => {
		expect(asLocale('pl')).toBe('pl');
		expect(asLocale('zh-CN')).toBe('zh-CN');
		expect(asLocale('es-ES')).toBe('es-ES');
	});

	test('refuses anything else, so a stale or hand-edited value cannot take effect', () => {
		for (const bad of ['xx', 'PL', 'zh', 'ES', 'es', '', 'en-US', null, undefined, 42, {}]) {
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

	test('a language carried only with a region resolves to that region', () => {
		expect(fromNavigator(['es'])).toBe('es-ES');
		expect(fromNavigator(['es-MX'])).toBe('es-ES');
		expect(fromNavigator(['fr'])).toBe('fr-FR');
		expect(fromNavigator(['fr-BE'])).toBe('fr-FR');
	});

	test('a sibling region of an earlier language beats a later exact match', () => {
		expect(fromNavigator(['es-MX', 'de'])).toBe('es-ES');
	});

	test('a language prefix is not a sibling of a longer language code', () => {
		// "e" must not match es-ES or en.
		expect(fromNavigator(['e'])).toBeUndefined();
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

// A browser that clears its storage on close loses the local choice; the server keeps it.
describe('the language kept on the server', () => {
	const urls: string[] = [];
	const respond = (status: number, body: unknown) => (async (url: string) => {
		urls.push(url);
		return new Response(JSON.stringify(body), { status });
	}) as unknown as typeof fetch;

	test('a stored language is read, and no choice is null', async () => {
		expect(await fetchServerLocale(respond(200, { language: 'en' }))).toBe('en');
		expect(await fetchServerLocale(respond(200, { language: null }))).toBe(null);
		expect(urls.every((u) => u === LANGUAGE_PREFERENCE_URL)).toBe(true);
	});

	test('a server that cannot say gives undefined: signed out, failing, unknown value, or down', async () => {
		expect(await fetchServerLocale(respond(401, { error: 'x' }))).toBe(undefined);
		expect(await fetchServerLocale(respond(500, {}))).toBe(undefined);
		expect(await fetchServerLocale(respond(200, { language: 'xx' }))).toBe(undefined);
		expect(await fetchServerLocale(respond(200, {}))).toBe(undefined);
		expect(await fetchServerLocale(respond(401, { language: 'de' }))).toBe(undefined);
		expect(await fetchServerLocale((async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBe(undefined);
	});

	test('a slow server is given up on, so the first render is not held', async () => {
		const hang = ((_u: string, init: RequestInit) => new Promise((_r, reject) => {
			init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
		})) as unknown as typeof fetch;
		const started = Date.now();
		expect(await fetchServerLocale(hang, 50)).toBe(undefined);
		expect(Date.now() - started).toBeLessThan(1000);
	});

	test('without an explicit timeout the first render waits about 1.5 s at most', async () => {
		const hang = ((_u: string, init: RequestInit) => new Promise((_r, reject) => {
			init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
		})) as unknown as typeof fetch;
		const started = Date.now();
		expect(await fetchServerLocale(hang)).toBe(undefined);
		const waited = Date.now() - started;
		expect(waited).toBeGreaterThanOrEqual(1400);
		expect(waited).toBeLessThan(2500);
	});

	test("the server's choice wins over the browser's copy; no server choice keeps the local one", () => {
		expect(storedAfterServer('en', 'de')).toBe('en');
		expect(storedAfterServer('en', null)).toBe('en');
		expect(storedAfterServer(null, 'de')).toBe('de');
		expect(storedAfterServer(undefined, 'de')).toBe('de');
		expect(storedAfterServer(undefined, null)).toBe(null);
	});

	test('after sign-in only a different server choice switches the language', () => {
		expect(localeToApply('de', 'pl')).toBe('de');
		expect(localeToApply('de', 'de')).toBe(null);
		expect(localeToApply('zh-CN', 'zh-CN')).toBe(null);
		expect(localeToApply(null, 'pl')).toBe(null);
		expect(localeToApply(undefined, 'pl')).toBe(null);
	});
});

/** A store that records what was written, or throws on every write when blocked. */
function memoryStore(initial: string | null = null, blocked = false) {
	let value = initial;
	return {
		get value() {
			return value;
		},
		getItem: (k: string) => (k === LOCALE_STORAGE_KEY ? value : null),
		setItem: (k: string, v: string) => {
			if (blocked) throw new Error('blocked');
			if (k === LOCALE_STORAGE_KEY) value = v;
		},
		removeItem: (k: string) => {
			if (blocked) throw new Error('blocked');
			if (k === LOCALE_STORAGE_KEY) value = null;
		}
	};
}

const answer = (status: number, body: unknown) =>
	(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

// The init hook: a browser that cleared its storage gets the server's language before the first render.
describe('restoreServerLocale', () => {
	test("the server's language fills an empty store", async () => {
		const store = memoryStore();
		await restoreServerLocale(answer(200, { language: 'de' }), store);
		expect(store.value).toBe('de');
	});

	test('no server choice, or no answer, keeps the local one', async () => {
		const a = memoryStore('pl');
		await restoreServerLocale(answer(200, { language: null }), a);
		expect(a.value).toBe('pl');
		const b = memoryStore('pl');
		await restoreServerLocale(answer(401, {}), b);
		expect(b.value).toBe('pl');
	});

	test('a blocked store does not throw', async () => {
		await restoreServerLocale(answer(200, { language: 'de' }), memoryStore(null, true));
	});
});

describe('signedInUserToCheck', () => {
	const user = { id: 7 };
	test('only a signed-in user with auth on, once per user', () => {
		expect(signedInUserToCheck({ loading: false, authEnabled: true, user }, undefined)).toBe(7);
		expect(signedInUserToCheck({ loading: false, authEnabled: true, user }, 7)).toBe(undefined);
		expect(signedInUserToCheck({ loading: false, authEnabled: true, user }, 3)).toBe(7);
		expect(signedInUserToCheck({ loading: true, authEnabled: true, user }, undefined)).toBe(undefined);
		expect(signedInUserToCheck({ loading: false, authEnabled: false, user }, undefined)).toBe(undefined);
		expect(signedInUserToCheck({ loading: false, authEnabled: true, user: null }, undefined)).toBe(undefined);
	});
});

// Sign-in does not reload the page, so the language rendered on /login may not be the user's.
describe('applySignedInLocale', () => {
	test("a different server language is stored and the page reloads once", async () => {
		const store = memoryStore('pl');
		let reloads = 0;
		await applySignedInLocale(answer(200, { language: 'de' }), 'pl', store, () => reloads++);
		expect(store.value).toBe('de');
		expect(reloads).toBe(1);
	});

	test('the same language, no choice or no answer changes nothing', async () => {
		for (const fetchFn of [answer(200, { language: 'pl' }), answer(200, { language: null }), answer(500, {})]) {
			const store = memoryStore('pl');
			let reloads = 0;
			await applySignedInLocale(fetchFn, 'pl', store, () => reloads++);
			expect(store.value).toBe('pl');
			expect(reloads).toBe(0);
		}
	});

	test('a blocked store never reloads, or it would loop', async () => {
		let reloads = 0;
		await applySignedInLocale(answer(200, { language: 'de' }), 'pl', memoryStore('pl', true), () => reloads++);
		expect(reloads).toBe(0);
	});
});

// The server copy wins on the next load, so a choice is stored locally only once the server has it.
describe('chooseLanguage', () => {
	const recorder = (status: number, getLanguage: unknown = null) => {
		const calls: { method: string; body?: string }[] = [];
		const fn = (async (_url: string, init?: RequestInit) => {
			calls.push({ method: init?.method ?? 'GET', body: init?.body as string | undefined });
			if ((init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify({ language: getLanguage }), { status: 200 });
			return new Response('{}', { status });
		}) as unknown as typeof fetch;
		return { fn, calls };
	};

	test('a saved language is stored and reloads', async () => {
		const { fn, calls } = recorder(200);
		const store = memoryStore('pl');
		let reloads = 0;
		expect(await chooseLanguage('de', fn, store, () => reloads++)).toBe('saved');
		expect(calls[0]).toEqual({ method: 'PUT', body: JSON.stringify({ language: 'de' }) });
		expect(store.value).toBe('de');
		expect(reloads).toBe(1);
	});

	test('following the browser sends null and removes the local choice', async () => {
		const { fn, calls } = recorder(200);
		const store = memoryStore('de');
		expect(await chooseLanguage(FOLLOW_BROWSER, fn, store, () => {})).toBe('saved');
		expect(calls[0].body).toBe(JSON.stringify({ language: null }));
		expect(store.value).toBe(null);
	});

	test('a refused save leaves the local choice and does not reload', async () => {
		for (const status of [500, 401, 400]) {
			const store = memoryStore('pl');
			let reloads = 0;
			expect(await chooseLanguage('de', recorder(status).fn, store, () => reloads++)).toBe('failed');
			expect(store.value).toBe('pl');
			expect(reloads).toBe(0);
		}
	});

	test('a request that errors is checked again: saved only if the server has it', async () => {
		const failing = (serverHas: unknown) =>
			(async (_url: string, init?: RequestInit) => {
				if (init?.method === 'PUT') throw new Error('timeout');
				return new Response(JSON.stringify({ language: serverHas }), { status: 200 });
			}) as unknown as typeof fetch;
		const a = memoryStore('pl');
		expect(await chooseLanguage('de', failing('de'), a, () => {})).toBe('saved');
		expect(a.value).toBe('de');
		const b = memoryStore('pl');
		expect(await chooseLanguage('de', failing('pl'), b, () => {})).toBe('failed');
		expect(b.value).toBe('pl');
		const c = memoryStore('de');
		expect(await chooseLanguage(FOLLOW_BROWSER, failing(null), c, () => {})).toBe('saved');
		expect(c.value).toBe(null);
	});

	test('a blocked store is reported and never reloads', async () => {
		let reloads = 0;
		expect(await chooseLanguage('de', recorder(200).fn, memoryStore('pl', true), () => reloads++)).toBe('blocked');
		expect(reloads).toBe(0);
	});

	test('a value that is not a language sends nothing', async () => {
		const { fn, calls } = recorder(200);
		expect(await chooseLanguage('xx', fn, memoryStore(), () => {})).toBe('ignored');
		expect(calls.length).toBe(0);
	});

	test('a hanging save gives up after the timeout', async () => {
		const hang = ((_u: string, init?: RequestInit) =>
			init?.method === 'PUT'
				? new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
				: Promise.resolve(new Response(JSON.stringify({ language: null }), { status: 200 }))) as unknown as typeof fetch;
		const started = Date.now();
		expect(await chooseLanguage('de', hang, memoryStore(), () => {}, 50)).toBe('failed');
		expect(Date.now() - started).toBeLessThan(1000);
	});
});
