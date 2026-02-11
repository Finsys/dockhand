import { json, type RequestHandler } from '@sveltejs/kit';
import {
	getSetting,
	setSetting,
	getScheduleRetentionDays,
	setScheduleRetentionDays,
	getEventRetentionDays,
	setEventRetentionDays,
	getScheduleCleanupCron,
	setScheduleCleanupCron,
	getEventCleanupCron,
	setEventCleanupCron,
	getScheduleCleanupEnabled,
	setScheduleCleanupEnabled,
	getEventCleanupEnabled,
	setEventCleanupEnabled,
	getDefaultTimezone,
	setDefaultTimezone,
	getEventCollectionMode,
	setEventCollectionMode,
	getEventPollInterval,
	setEventPollInterval,
	getMetricsCollectionInterval,
	setMetricsCollectionInterval,
	getExternalStackPaths,
	setExternalStackPaths,
	getPrimaryStackLocation,
	setPrimaryStackLocation
} from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { refreshSystemJobs } from '$lib/server/scheduler';
import { sendToEventSubprocess, sendToMetricsSubprocess, type UpdateIntervalCommand } from '$lib/server/subprocess-manager';

export type TimeFormat = '12h' | '24h';
export type DateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'DD.MM.YYYY';
export type DownloadFormat = 'tar' | 'tar.gz';
export type EventCollectionMode = 'stream' | 'poll';

export interface GeneralSettings {
	confirmDestructive: boolean;
	showStoppedContainers: boolean;
	highlightUpdates: boolean;
	timeFormat: TimeFormat;
	dateFormat: DateFormat;
	downloadFormat: DownloadFormat;
	defaultGrypeArgs: string;
	defaultTrivyArgs: string;
	scheduleRetentionDays: number;
	eventRetentionDays: number;
	scheduleCleanupCron: string;
	eventCleanupCron: string;
	scheduleCleanupEnabled: boolean;
	eventCleanupEnabled: boolean;
	logBufferSizeKb: number;
	defaultTimezone: string;
	// Background monitoring settings
	eventCollectionMode: EventCollectionMode;
	eventPollInterval: number;
	metricsCollectionInterval: number;
	// Theme settings (for when auth is disabled)
	lightTheme: string;
	darkTheme: string;
	font: string;
	fontSize: string;
	gridFontSize: string;
	terminalFont: string;
	editorFont: string;
	// External stack paths
	externalStackPaths: string[];
	// Primary stack location
	primaryStackLocation: string | null;
}

const DEFAULT_SETTINGS: Omit<GeneralSettings, 'scheduleRetentionDays' | 'eventRetentionDays' | 'scheduleCleanupCron' | 'eventCleanupCron' | 'scheduleCleanupEnabled' | 'eventCleanupEnabled'> = {
	confirmDestructive: true,
	showStoppedContainers: true,
	highlightUpdates: true,
	timeFormat: '24h',
	dateFormat: 'DD.MM.YYYY',
	downloadFormat: 'tar',
	defaultGrypeArgs: '-o json -v {image}',
	defaultTrivyArgs: 'image --format json {image}',
	logBufferSizeKb: 500,
	defaultTimezone: 'UTC',
	eventCollectionMode: 'stream',
	eventPollInterval: 60000,
	metricsCollectionInterval: 30000,
	lightTheme: 'default',
	darkTheme: 'default',
	font: 'system',
	fontSize: 'normal',
	gridFontSize: 'normal',
	terminalFont: 'system-mono',
	editorFont: 'system-mono'
};

const VALID_LIGHT_THEMES = ['default', 'catppuccin', 'rose-pine', 'nord', 'solarized', 'gruvbox', 'alucard', 'github', 'material', 'atom-one'];
const VALID_DARK_THEMES = ['default', 'catppuccin', 'dracula', 'rose-pine', 'rose-pine-moon', 'tokyo-night', 'nord', 'one-dark', 'gruvbox', 'solarized', 'everforest', 'kanagawa', 'monokai', 'monokai-pro', 'material', 'palenight', 'github'];
const VALID_FONTS = ['system', 'geist', 'inter', 'plus-jakarta', 'dm-sans', 'outfit', 'space-grotesk', 'sofia-sans', 'nunito', 'poppins', 'montserrat', 'raleway', 'manrope', 'roboto', 'open-sans', 'lato', 'source-sans', 'work-sans', 'fira-sans', 'jetbrains-mono', 'fira-code', 'quicksand', 'comfortaa'];
const VALID_FONT_SIZES = ['xsmall', 'small', 'normal', 'medium', 'large', 'xlarge'];
const VALID_TERMINAL_FONTS = ['system-mono', 'jetbrains-mono', 'fira-code', 'source-code-pro', 'cascadia-code', 'ibm-plex-mono', 'roboto-mono', 'ubuntu-mono', 'space-mono', 'inconsolata', 'hack', 'anonymous-pro', 'dm-mono', 'red-hat-mono', 'menlo', 'consolas', 'sf-mono'];
const VALID_EDITOR_FONTS = VALID_TERMINAL_FONTS;

const VALID_DATE_FORMATS: DateFormat[] = ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD', 'DD.MM.YYYY'];

export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);
	// UI preferences (time format, date format) should be available to all authenticated users
	// This doesn't expose sensitive data and is needed for proper UI rendering
	if (auth.authEnabled && !auth.isAuthenticated) {
		return json({ error: 'Authentication required' }, { status: 401 });
	}

	try {
		// Fetch all settings in parallel for better performance
		const [
			confirmDestructive,
			showStoppedContainers,
			highlightUpdates,
			timeFormat,
			dateFormat,
			downloadFormat,
			defaultGrypeArgs,
			defaultTrivyArgs,
			scheduleRetentionDays,
			eventRetentionDays,
			scheduleCleanupCron,
			eventCleanupCron,
			scheduleCleanupEnabled,
			eventCleanupEnabled,
			logBufferSizeKb,
			defaultTimezone,
			eventCollectionMode,
			eventPollInterval,
			metricsCollectionInterval,
			lightTheme,
			darkTheme,
			font,
			fontSize,
			gridFontSize,
			terminalFont,
			editorFont,
			externalStackPaths,
			primaryStackLocation
		] = await Promise.all([
			getSetting('confirm_destructive'),
			getSetting('show_stopped_containers'),
			getSetting('highlight_updates'),
			getSetting('time_format'),
			getSetting('date_format'),
			getSetting('download_format'),
			getSetting('default_grype_args'),
			getSetting('default_trivy_args'),
			getScheduleRetentionDays(),
			getEventRetentionDays(),
			getScheduleCleanupCron(),
			getEventCleanupCron(),
			getScheduleCleanupEnabled(),
			getEventCleanupEnabled(),
			getSetting('log_buffer_size_kb'),
			getDefaultTimezone(),
			getEventCollectionMode(),
			getEventPollInterval(),
			getMetricsCollectionInterval(),
			getSetting('theme_light'),
			getSetting('theme_dark'),
			getSetting('theme_font'),
			getSetting('theme_font_size'),
			getSetting('theme_grid_font_size'),
			getSetting('theme_terminal_font'),
			getSetting('theme_editor_font'),
			getExternalStackPaths(),
			getPrimaryStackLocation()
		]);

		const settings: GeneralSettings = {
			confirmDestructive: confirmDestructive ?? DEFAULT_SETTINGS.confirmDestructive,
			showStoppedContainers: showStoppedContainers ?? DEFAULT_SETTINGS.showStoppedContainers,
			highlightUpdates: highlightUpdates ?? DEFAULT_SETTINGS.highlightUpdates,
			timeFormat: timeFormat ?? DEFAULT_SETTINGS.timeFormat,
			dateFormat: dateFormat ?? DEFAULT_SETTINGS.dateFormat,
			downloadFormat: downloadFormat ?? DEFAULT_SETTINGS.downloadFormat,
			defaultGrypeArgs: defaultGrypeArgs ?? DEFAULT_SETTINGS.defaultGrypeArgs,
			defaultTrivyArgs: defaultTrivyArgs ?? DEFAULT_SETTINGS.defaultTrivyArgs,
			scheduleRetentionDays,
			eventRetentionDays,
			scheduleCleanupCron,
			eventCleanupCron,
			scheduleCleanupEnabled,
			eventCleanupEnabled,
			logBufferSizeKb: logBufferSizeKb ?? DEFAULT_SETTINGS.logBufferSizeKb,
			defaultTimezone: defaultTimezone ?? DEFAULT_SETTINGS.defaultTimezone,
			eventCollectionMode: (eventCollectionMode ?? DEFAULT_SETTINGS.eventCollectionMode) as EventCollectionMode,
			eventPollInterval: eventPollInterval ?? DEFAULT_SETTINGS.eventPollInterval,
			metricsCollectionInterval: metricsCollectionInterval ?? DEFAULT_SETTINGS.metricsCollectionInterval,
			lightTheme: lightTheme ?? DEFAULT_SETTINGS.lightTheme,
			darkTheme: darkTheme ?? DEFAULT_SETTINGS.darkTheme,
			font: font ?? DEFAULT_SETTINGS.font,
			fontSize: fontSize ?? DEFAULT_SETTINGS.fontSize,
			gridFontSize: gridFontSize ?? DEFAULT_SETTINGS.gridFontSize,
			terminalFont: terminalFont ?? DEFAULT_SETTINGS.terminalFont,
			editorFont: editorFont ?? DEFAULT_SETTINGS.editorFont,
			externalStackPaths,
			primaryStackLocation
		};

		return json(settings);
	} catch (error) {
		console.error('Failed to get general settings:', error);
		return json({ error: 'Failed to get general settings' }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('settings', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const body = await request.json();
		const { confirmDestructive, showStoppedContainers, highlightUpdates, timeFormat, dateFormat, downloadFormat, defaultGrypeArgs, defaultTrivyArgs, scheduleRetentionDays, eventRetentionDays, scheduleCleanupCron, eventCleanupCron, scheduleCleanupEnabled, eventCleanupEnabled, logBufferSizeKb, defaultTimezone, eventCollectionMode, eventPollInterval, metricsCollectionInterval, lightTheme, darkTheme, font, fontSize, gridFontSize, terminalFont, editorFont, externalStackPaths, primaryStackLocation } = body;

		if (confirmDestructive !== undefined) {
			await setSetting('confirm_destructive', confirmDestructive);
		}
		if (showStoppedContainers !== undefined) {
			await setSetting('show_stopped_containers', showStoppedContainers);
		}
		if (highlightUpdates !== undefined) {
			await setSetting('highlight_updates', highlightUpdates);
		}
		if (timeFormat !== undefined && (timeFormat === '12h' || timeFormat === '24h')) {
			await setSetting('time_format', timeFormat);
		}
		if (dateFormat !== undefined && VALID_DATE_FORMATS.includes(dateFormat)) {
			await setSetting('date_format', dateFormat);
		}
		if (downloadFormat !== undefined && (downloadFormat === 'tar' || downloadFormat === 'tar.gz')) {
			await setSetting('download_format', downloadFormat);
		}
		if (defaultGrypeArgs !== undefined && typeof defaultGrypeArgs === 'string') {
			await setSetting('default_grype_args', defaultGrypeArgs);
		}
		if (defaultTrivyArgs !== undefined && typeof defaultTrivyArgs === 'string') {
			await setSetting('default_trivy_args', defaultTrivyArgs);
		}
		if (scheduleRetentionDays !== undefined && typeof scheduleRetentionDays === 'number') {
			await setScheduleRetentionDays(Math.max(1, Math.min(365, scheduleRetentionDays)));
		}
		if (eventRetentionDays !== undefined && typeof eventRetentionDays === 'number') {
			await setEventRetentionDays(Math.max(1, Math.min(365, eventRetentionDays)));
		}
		if (scheduleCleanupCron !== undefined && typeof scheduleCleanupCron === 'string') {
			await setScheduleCleanupCron(scheduleCleanupCron);
		}
		if (eventCleanupCron !== undefined && typeof eventCleanupCron === 'string') {
			await setEventCleanupCron(eventCleanupCron);
		}
		if (scheduleCleanupEnabled !== undefined && typeof scheduleCleanupEnabled === 'boolean') {
			await setScheduleCleanupEnabled(scheduleCleanupEnabled);
		}
		if (eventCleanupEnabled !== undefined && typeof eventCleanupEnabled === 'boolean') {
			await setEventCleanupEnabled(eventCleanupEnabled);
		}
		if (logBufferSizeKb !== undefined && typeof logBufferSizeKb === 'number') {
			// Clamp to reasonable range: 100KB - 5000KB (5MB)
			await setSetting('log_buffer_size_kb', Math.max(100, Math.min(5000, logBufferSizeKb)));
		}
		if (defaultTimezone !== undefined && typeof defaultTimezone === 'string') {
			await setDefaultTimezone(defaultTimezone);
			// Refresh system jobs to use the new timezone
			await refreshSystemJobs();
		}
		if (eventCollectionMode !== undefined && (eventCollectionMode === 'stream' || eventCollectionMode === 'poll')) {
			await setEventCollectionMode(eventCollectionMode);
			// Notify event subprocess to refresh collectors with new mode
			sendToEventSubprocess({ type: 'refresh_environments' });
		}
		if (eventPollInterval !== undefined && typeof eventPollInterval === 'number') {
			// Validate: 30s - 300s (30 seconds to 5 minutes)
			const validatedInterval = Math.max(30000, Math.min(300000, eventPollInterval));
			await setEventPollInterval(validatedInterval);
			// Notify event subprocess to refresh collectors with new interval
			sendToEventSubprocess({ type: 'refresh_environments' });
		}
		if (metricsCollectionInterval !== undefined && typeof metricsCollectionInterval === 'number') {
			// Validate: 10s - 300s (10 seconds to 5 minutes)
			const validatedInterval = Math.max(10000, Math.min(300000, metricsCollectionInterval));
			await setMetricsCollectionInterval(validatedInterval);
			// Notify metrics subprocess to update its collection interval
			sendToMetricsSubprocess({ type: 'update_interval', intervalMs: validatedInterval });
		}
		if (lightTheme !== undefined && VALID_LIGHT_THEMES.includes(lightTheme)) {
			await setSetting('theme_light', lightTheme);
		}
		if (darkTheme !== undefined && VALID_DARK_THEMES.includes(darkTheme)) {
			await setSetting('theme_dark', darkTheme);
		}
		if (font !== undefined && VALID_FONTS.includes(font)) {
			await setSetting('theme_font', font);
		}
		if (fontSize !== undefined && VALID_FONT_SIZES.includes(fontSize)) {
			await setSetting('theme_font_size', fontSize);
		}
		if (gridFontSize !== undefined && VALID_FONT_SIZES.includes(gridFontSize)) {
			await setSetting('theme_grid_font_size', gridFontSize);
		}
		if (terminalFont !== undefined && VALID_TERMINAL_FONTS.includes(terminalFont)) {
			await setSetting('theme_terminal_font', terminalFont);
		}
		if (editorFont !== undefined && VALID_EDITOR_FONTS.includes(editorFont)) {
			await setSetting('theme_editor_font', editorFont);
		}
		if (externalStackPaths !== undefined && Array.isArray(externalStackPaths)) {
			// Filter to valid non-empty strings
			const validPaths = externalStackPaths.filter((p: unknown) => typeof p === 'string' && p.trim());
			await setExternalStackPaths(validPaths);
		}
		if (primaryStackLocation !== undefined) {
			// Accept string or null
			if (primaryStackLocation === null || (typeof primaryStackLocation === 'string' && primaryStackLocation.trim())) {
				await setPrimaryStackLocation(primaryStackLocation);
			} else if (primaryStackLocation === '') {
				// Empty string means clear the setting
				await setPrimaryStackLocation(null);
			}
		}

		// Fetch all settings in parallel for the response
		const [
			confirmDestructiveVal,
			showStoppedContainersVal,
			highlightUpdatesVal,
			timeFormatVal,
			dateFormatVal,
			downloadFormatVal,
			defaultGrypeArgsVal,
			defaultTrivyArgsVal,
			scheduleRetentionDaysVal,
			eventRetentionDaysVal,
			scheduleCleanupCronVal,
			eventCleanupCronVal,
			scheduleCleanupEnabledVal,
			eventCleanupEnabledVal,
			logBufferSizeKbVal,
			defaultTimezoneVal,
			eventCollectionModeVal,
			eventPollIntervalVal,
			metricsCollectionIntervalVal,
			lightThemeVal,
			darkThemeVal,
			fontVal,
			fontSizeVal,
			gridFontSizeVal,
			terminalFontVal,
			editorFontVal,
			externalStackPathsVal,
			primaryStackLocationVal
		] = await Promise.all([
			getSetting('confirm_destructive'),
			getSetting('show_stopped_containers'),
			getSetting('highlight_updates'),
			getSetting('time_format'),
			getSetting('date_format'),
			getSetting('download_format'),
			getSetting('default_grype_args'),
			getSetting('default_trivy_args'),
			getScheduleRetentionDays(),
			getEventRetentionDays(),
			getScheduleCleanupCron(),
			getEventCleanupCron(),
			getScheduleCleanupEnabled(),
			getEventCleanupEnabled(),
			getSetting('log_buffer_size_kb'),
			getDefaultTimezone(),
			getEventCollectionMode(),
			getEventPollInterval(),
			getMetricsCollectionInterval(),
			getSetting('theme_light'),
			getSetting('theme_dark'),
			getSetting('theme_font'),
			getSetting('theme_font_size'),
			getSetting('theme_grid_font_size'),
			getSetting('theme_terminal_font'),
			getSetting('theme_editor_font'),
			getExternalStackPaths(),
			getPrimaryStackLocation()
		]);

		const settings: GeneralSettings = {
			confirmDestructive: confirmDestructiveVal ?? DEFAULT_SETTINGS.confirmDestructive,
			showStoppedContainers: showStoppedContainersVal ?? DEFAULT_SETTINGS.showStoppedContainers,
			highlightUpdates: highlightUpdatesVal ?? DEFAULT_SETTINGS.highlightUpdates,
			timeFormat: timeFormatVal ?? DEFAULT_SETTINGS.timeFormat,
			dateFormat: dateFormatVal ?? DEFAULT_SETTINGS.dateFormat,
			downloadFormat: downloadFormatVal ?? DEFAULT_SETTINGS.downloadFormat,
			defaultGrypeArgs: defaultGrypeArgsVal ?? DEFAULT_SETTINGS.defaultGrypeArgs,
			defaultTrivyArgs: defaultTrivyArgsVal ?? DEFAULT_SETTINGS.defaultTrivyArgs,
			scheduleRetentionDays: scheduleRetentionDaysVal,
			eventRetentionDays: eventRetentionDaysVal,
			scheduleCleanupCron: scheduleCleanupCronVal,
			eventCleanupCron: eventCleanupCronVal,
			scheduleCleanupEnabled: scheduleCleanupEnabledVal,
			eventCleanupEnabled: eventCleanupEnabledVal,
			logBufferSizeKb: logBufferSizeKbVal ?? DEFAULT_SETTINGS.logBufferSizeKb,
			defaultTimezone: defaultTimezoneVal ?? DEFAULT_SETTINGS.defaultTimezone,
			eventCollectionMode: (eventCollectionModeVal ?? DEFAULT_SETTINGS.eventCollectionMode) as EventCollectionMode,
			eventPollInterval: eventPollIntervalVal ?? DEFAULT_SETTINGS.eventPollInterval,
			metricsCollectionInterval: metricsCollectionIntervalVal ?? DEFAULT_SETTINGS.metricsCollectionInterval,
			lightTheme: lightThemeVal ?? DEFAULT_SETTINGS.lightTheme,
			darkTheme: darkThemeVal ?? DEFAULT_SETTINGS.darkTheme,
			font: fontVal ?? DEFAULT_SETTINGS.font,
			fontSize: fontSizeVal ?? DEFAULT_SETTINGS.fontSize,
			gridFontSize: gridFontSizeVal ?? DEFAULT_SETTINGS.gridFontSize,
			terminalFont: terminalFontVal ?? DEFAULT_SETTINGS.terminalFont,
			editorFont: editorFontVal ?? DEFAULT_SETTINGS.editorFont,
			externalStackPaths: externalStackPathsVal,
			primaryStackLocation: primaryStackLocationVal
		};

		return json(settings);
	} catch (error) {
		console.error('Failed to save general settings:', error);
		return json({ error: 'Failed to save general settings' }, { status: 500 });
	}
};
