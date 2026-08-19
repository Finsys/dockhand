import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { getUserThemePreferences, setUserThemePreferences } from '$lib/server/db';
import { validateSession, isAuthEnabled } from '$lib/server/auth';
import { lightThemes, darkThemes, fonts, monospaceFonts } from '$lib/themes';

// GET /api/profile/preferences - Get current user's theme preferences
/**
 * @openapi
 * summary: Get the current user's UI preferences (theme, fonts, editor options)
 * resp-400: Not authenticated / no user in context
 * resp-401: Not authenticated
 * resp-500: Failed to load preferences
 */
export const GET: RequestHandler = async ({ cookies }) => {
	if (!(await isAuthEnabled())) {
		return json({ error: 'Authentication is not enabled' }, { status: 400 });
	}

	const currentUser = await validateSession(cookies);
	if (!currentUser) {
		return json({ error: 'Not authenticated' }, { status: 401 });
	}

	try {
		const prefs = await getUserThemePreferences(currentUser.id);
		return json(prefs);
	} catch (error) {
		console.error('Failed to get preferences:', error);
		return json({ error: 'Failed to get preferences' }, { status: 500 });
	}
};

// PUT /api/profile/preferences - Update current user's theme preferences
/**
 * @openapi
 * summary: Update the current user's UI preferences (each field is optional)
 * body: {lightTheme:string, darkTheme:string, font:string, fontSize:string, gridFontSize:string, terminalFont:string, editorFont:string, animateIcons:boolean, coloredActionButtons:boolean, actionIconSize:string, editorIndentGuides:boolean}
 * resp-400: A supplied field has the wrong type (e.g. editorIndentGuides not a boolean)
 * resp-401: Not authenticated
 * resp-500: Failed to save preferences
 */
export const PUT: RequestHandler = async ({ request, cookies }) => {
	if (!(await isAuthEnabled())) {
		return json({ error: 'Authentication is not enabled' }, { status: 400 });
	}

	const currentUser = await validateSession(cookies);
	if (!currentUser) {
		return json({ error: 'Not authenticated' }, { status: 401 });
	}

	try {
		const data = await request.json();

		// Validate theme values using imported theme lists
		const validLightThemeIds = lightThemes.map(t => t.id);
		const validDarkThemeIds = darkThemes.map(t => t.id);
		const validFontIds = fonts.map(f => f.id);
		const validTerminalFontIds = monospaceFonts.map(f => f.id);
		const validFontSizes = ['xsmall', 'small', 'normal', 'medium', 'large', 'xlarge'];

		const validActionIconSizes = ['small', 'normal', 'large', 'xlarge'];

		const updates: { lightTheme?: string; darkTheme?: string; font?: string; fontSize?: string; gridFontSize?: string; terminalFont?: string; editorFont?: string; animateIcons?: boolean; coloredActionButtons?: boolean; actionIconSize?: string; editorIndentGuides?: boolean } = {};

		if (data.lightTheme !== undefined) {
			if (!validLightThemeIds.includes(data.lightTheme)) {
				return json({ error: 'Invalid light theme' }, { status: 400 });
			}
			updates.lightTheme = data.lightTheme;
		}

		if (data.darkTheme !== undefined) {
			if (!validDarkThemeIds.includes(data.darkTheme)) {
				return json({ error: 'Invalid dark theme' }, { status: 400 });
			}
			updates.darkTheme = data.darkTheme;
		}

		if (data.font !== undefined) {
			if (!validFontIds.includes(data.font)) {
				return json({ error: 'Invalid font' }, { status: 400 });
			}
			updates.font = data.font;
		}

		if (data.fontSize !== undefined) {
			if (!validFontSizes.includes(data.fontSize)) {
				return json({ error: 'Invalid font size' }, { status: 400 });
			}
			updates.fontSize = data.fontSize;
		}

		if (data.gridFontSize !== undefined) {
			if (!validFontSizes.includes(data.gridFontSize)) {
				return json({ error: 'Invalid grid font size' }, { status: 400 });
			}
			updates.gridFontSize = data.gridFontSize;
		}

		if (data.terminalFont !== undefined) {
			if (!validTerminalFontIds.includes(data.terminalFont)) {
				return json({ error: 'Invalid terminal font' }, { status: 400 });
			}
			updates.terminalFont = data.terminalFont;
		}

		if (data.editorFont !== undefined) {
			if (!validTerminalFontIds.includes(data.editorFont)) {
				return json({ error: 'Invalid editor font' }, { status: 400 });
			}
			updates.editorFont = data.editorFont;
		}

		if (data.animateIcons !== undefined) {
			if (typeof data.animateIcons !== 'boolean') {
				return json({ error: 'Invalid animateIcons' }, { status: 400 });
			}
			updates.animateIcons = data.animateIcons;
		}

		if (data.editorIndentGuides !== undefined) {
			if (typeof data.editorIndentGuides !== 'boolean') {
				return json({ error: 'Invalid editorIndentGuides' }, { status: 400 });
			}
			updates.editorIndentGuides = data.editorIndentGuides;
		}

		if (data.coloredActionButtons !== undefined) {
			if (typeof data.coloredActionButtons !== 'boolean') {
				return json({ error: 'Invalid coloredActionButtons' }, { status: 400 });
			}
			updates.coloredActionButtons = data.coloredActionButtons;
		}

		if (data.actionIconSize !== undefined) {
			if (!validActionIconSizes.includes(data.actionIconSize)) {
				return json({ error: 'Invalid actionIconSize' }, { status: 400 });
			}
			updates.actionIconSize = data.actionIconSize;
		}

		await setUserThemePreferences(currentUser.id, updates);

		// Return updated preferences
		const prefs = await getUserThemePreferences(currentUser.id);
		return json(prefs);
	} catch (error) {
		console.error('Failed to update preferences:', error);
		return json({ error: 'Failed to update preferences' }, { status: 500 });
	}
};
