import { json, type RequestHandler } from '@sveltejs/kit';
import { getLanguagePreference, setLanguagePreference } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { asLocale } from '$lib/i18n/locale-preference';

// The interface language is kept per user when auth is on, for the install when it is off,
// so a browser that clears its storage on close still gets it back.

/**
 * @openapi
 * summary: Get the chosen interface language (null when the browser's language is followed)
 * resp-200: {language:string}
 * resp-200-desc: language is a locale code, or null when the browser's language is followed
 * resp-200-example: {"language":"en"}
 * resp-500: Failed to get the language preference
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);
	try {
		const userId = auth.authEnabled ? auth.user?.id : undefined;
		const language = asLocale(await getLanguagePreference(userId)) ?? null;
		return json({ language });
	} catch (error) {
		console.error('Failed to get language preference:', error);
		return json({ error: 'Failed to get the language preference' }, { status: 500 });
	}
};

/**
 * @openapi
 * summary: Set the interface language; null goes back to following the browser
 * body: {language:string}
 * body-example: {"language":"en"}
 * resp-200: {language:string}
 * resp-200-desc: The stored language, a locale code or null
 * resp-200-example: {"language":"en"}
 * resp-400: language is not one of the interface languages, or null
 * resp-500: Failed to save the language preference
 */
export const PUT: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	try {
		const body = await request.json().catch(() => undefined);
		const language = body?.language === null ? null : asLocale(body?.language);
		if (language === undefined) {
			return json({ error: 'language must be one of the interface languages, or null' }, { status: 400 });
		}
		const userId = auth.authEnabled ? auth.user?.id : undefined;
		await setLanguagePreference(language, userId);
		return json({ language });
	} catch (error) {
		console.error('Failed to save language preference:', error);
		return json({ error: 'Failed to save the language preference' }, { status: 500 });
	}
};
