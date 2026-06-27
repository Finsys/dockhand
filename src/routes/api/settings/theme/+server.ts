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
	editorFont: 'system-mono',
	animateIcons: true,
	coloredActionButtons: false,
	actionIconSize: 'normal'
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
			editorFont,
			animateIcons,
			coloredActionButtons,
			actionIconSize
		] = await Promise.all([
			getSetting('theme_light'),
			getSetting('theme_dark'),
			getSetting('theme_font'),
			getSetting('theme_font_size'),
			getSetting('theme_grid_font_size'),
			getSetting('theme_terminal_font'),
			getSetting('theme_editor_font'),
			getSetting('animate_icons'),
			getSetting('colored_action_buttons'),
			getSetting('action_icon_size')
		]);

		return json({
			lightTheme: lightTheme ?? DEFAULT_THEME_SETTINGS.lightTheme,
			darkTheme: darkTheme ?? DEFAULT_THEME_SETTINGS.darkTheme,
			font: font ?? DEFAULT_THEME_SETTINGS.font,
			fontSize: fontSize ?? DEFAULT_THEME_SETTINGS.fontSize,
			gridFontSize: gridFontSize ?? DEFAULT_THEME_SETTINGS.gridFontSize,
			terminalFont: terminalFont ?? DEFAULT_THEME_SETTINGS.terminalFont,
			editorFont: editorFont ?? DEFAULT_THEME_SETTINGS.editorFont,
			animateIcons: animateIcons ?? DEFAULT_THEME_SETTINGS.animateIcons,
			coloredActionButtons: coloredActionButtons ?? DEFAULT_THEME_SETTINGS.coloredActionButtons,
			actionIconSize: actionIconSize ?? DEFAULT_THEME_SETTINGS.actionIconSize
		});
	} catch (error) {
		console.error('Failed to get theme settings:', error);
		// Return defaults on error
		return json(DEFAULT_THEME_SETTINGS);
	}
};
