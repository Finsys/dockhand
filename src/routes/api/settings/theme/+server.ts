import { json, type RequestHandler } from '@sveltejs/kit';
import { getSetting } from '$lib/server/db';

/**
 * Public endpoint for theme settings - no authentication required.
 * Used by the login page to apply the app-level theme before user is authenticated.
 */

const DEFAULT_THEME_SETTINGS = {
	lightTheme: 'default',
	darkTheme: 'default',
	font: 'system',
	fontSize: 'normal',
	gridFontSize: 'normal',
	terminalFont: 'system-mono',
	editorFont: 'system-mono'
};

export const GET: RequestHandler = async () => {
	try {
		const [
			lightTheme,
			darkTheme,
			font,
			fontSize,
			gridFontSize,
			terminalFont,
			editorFont
		] = await Promise.all([
			getSetting('theme_light'),
			getSetting('theme_dark'),
			getSetting('theme_font'),
			getSetting('theme_font_size'),
			getSetting('theme_grid_font_size'),
			getSetting('theme_terminal_font'),
			getSetting('theme_editor_font')
		]);

		return json({
			lightTheme: lightTheme ?? DEFAULT_THEME_SETTINGS.lightTheme,
			darkTheme: darkTheme ?? DEFAULT_THEME_SETTINGS.darkTheme,
			font: font ?? DEFAULT_THEME_SETTINGS.font,
			fontSize: fontSize ?? DEFAULT_THEME_SETTINGS.fontSize,
			gridFontSize: gridFontSize ?? DEFAULT_THEME_SETTINGS.gridFontSize,
			terminalFont: terminalFont ?? DEFAULT_THEME_SETTINGS.terminalFont,
			editorFont: editorFont ?? DEFAULT_THEME_SETTINGS.editorFont
		});
	} catch (error) {
		console.error('Failed to get theme settings:', error);
		// Return defaults on error
		return json(DEFAULT_THEME_SETTINGS);
	}
};
