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
	getScannerCleanupCron,
	setScannerCleanupCron,
	getScannerCleanupEnabled,
	setScannerCleanupEnabled,
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
import { sendToEventSubprocess, sendToMetricsSubprocess } from '$lib/server/subprocess-manager';
import { DEFAULT_GRYPE_IMAGE, DEFAULT_TRIVY_IMAGE } from '$lib/server/scanner';

export type TimeFormat = '12h' | '24h';
export type DateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'DD.MM.YYYY';
export type DownloadFormat = 'tar' | 'tar.gz' | 'raw';
export type EventCollectionMode = 'stream' | 'poll';
export type ActionIconSize = 'small' | 'normal' | 'large' | 'xlarge';

const VALID_ACTION_ICON_SIZES: ActionIconSize[] = ['small', 'normal', 'large', 'xlarge'];

export interface GeneralSettings {
	confirmDestructive: boolean;
	showStoppedContainers: boolean;
	highlightUpdates: boolean;
	coloredActionButtons: boolean;
	actionIconSize: ActionIconSize;
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
	scannerCleanupCron: string;
	scannerCleanupEnabled: boolean;
	logBufferSizeKb: number;  // legacy
	logMaxLines: number;       // line-count cap for log buffer
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
	// Compact ports
	compactPorts: boolean;
	// Show exposed (internal) ports
	showExposedPorts: boolean;
	// Log timestamp formatting
	formatLogTimestamps: boolean;
	// External stack paths
	externalStackPaths: string[];
	// Primary stack location
	primaryStackLocation: string | null;
	// Scanner images
	defaultGrypeImage: string;
	defaultTrivyImage: string;
	// Compose template
	defaultComposeTemplate: string;
	// Label filter mode
	labelFilterMode: 'any' | 'all';
	// Whether to surface URLs inferred from reverse-proxy labels — currently
	// Traefik (traefik.http.routers.*) and Pangolin
	// (pangolin.{public,private}-resources.*).
	// When false both parsers are bypassed and no proxy-derived pills are rendered.
	honorProxyLabels: boolean;
	// Whether to surface a "view changelog" link next to the update badge.
	// Resolved client-side from OCI labels / GHCR image names; no server hit.
	showImageChangelogLinks: boolean;
	// Whether spinning icons (animate-spin etc.) are animated (#1169)
	animateIcons: boolean;
	// Skip Dockhand's scanner images (grype, trivy) during 'prune all unused' (#625)
	protectScannerImages: boolean;
	// Scanner Advanced settings (#1219). Empty = use auto-detection.
	defaultScannerNetworkMode: string;
	defaultScannerDns: string[];
}

const DEFAULT_SETTINGS: Omit<GeneralSettings, 'scheduleRetentionDays' | 'eventRetentionDays' | 'scheduleCleanupCron' | 'eventCleanupCron' | 'scheduleCleanupEnabled' | 'eventCleanupEnabled' | 'scannerCleanupCron' | 'scannerCleanupEnabled'> = {
	confirmDestructive: true,
	showStoppedContainers: true,
	highlightUpdates: true,
	coloredActionButtons: false,
	actionIconSize: 'normal' as const,
	timeFormat: '24h',
	dateFormat: 'DD.MM.YYYY',
	downloadFormat: 'tar',
	defaultGrypeArgs: '-o json -v {image}',
	defaultTrivyArgs: 'image --format json {image}',
	logBufferSizeKb: 500,
	logMaxLines: 2000,
	defaultTimezone: 'UTC',
	eventCollectionMode: 'stream',
	eventPollInterval: 60000,
	metricsCollectionInterval: 30000,
	compactPorts: false,
	showExposedPorts: false,
	formatLogTimestamps: false,
	lightTheme: 'default',
	darkTheme: 'default',
	font: 'system',
	fontSize: 'normal',
	gridFontSize: 'normal',
	terminalFont: 'system-mono',
	editorFont: 'system-mono',
	externalStackPaths: [],
	primaryStackLocation: null,
	defaultGrypeImage: DEFAULT_GRYPE_IMAGE,
	defaultTrivyImage: DEFAULT_TRIVY_IMAGE,
	labelFilterMode: 'any' as const,
	honorProxyLabels: true,
	showImageChangelogLinks: true,
	animateIcons: true,
	protectScannerImages: true,
	defaultScannerNetworkMode: '',
	defaultScannerDns: [],
	defaultComposeTemplate: `version: "3.8"

services:
  app:
    image: nginx:alpine
    ports:
      - "8080:80"
    environment:
      - APP_ENV=\${APP_ENV:-production}
    volumes:
      - ./html:/usr/share/nginx/html:ro
    restart: unless-stopped

# Add more services as needed
# networks:
#   default:
#     driver: bridge
`
};

const VALID_LIGHT_THEMES = ['default', 'catppuccin', 'rose-pine', 'nord', 'solarized', 'gruvbox', 'alucard', 'github', 'material', 'atom-one'];
const VALID_DARK_THEMES = ['default', 'catppuccin', 'dracula', 'rose-pine', 'rose-pine-moon', 'tokyo-night', 'nord', 'one-dark', 'gruvbox', 'solarized', 'everforest', 'kanagawa', 'monokai', 'monokai-pro', 'material', 'palenight', 'github'];
const VALID_FONTS = ['system', 'geist', 'inter', 'plus-jakarta', 'dm-sans', 'outfit', 'space-grotesk', 'sofia-sans', 'nunito', 'poppins', 'montserrat', 'raleway', 'manrope', 'roboto', 'open-sans', 'lato', 'source-sans', 'work-sans', 'fira-sans', 'jetbrains-mono', 'fira-code', 'quicksand', 'comfortaa'];
const VALID_FONT_SIZES = ['xsmall', 'small', 'normal', 'medium', 'large', 'xlarge'];
const VALID_TERMINAL_FONTS = ['system-mono', 'jetbrains-mono', 'fira-code', 'source-code-pro', 'cascadia-code', 'ibm-plex-mono', 'roboto-mono', 'ubuntu-mono', 'space-mono', 'inconsolata', 'hack', 'anonymous-pro', 'dm-mono', 'red-hat-mono', 'menlo', 'consolas', 'sf-mono'];
const VALID_EDITOR_FONTS = VALID_TERMINAL_FONTS;

const VALID_DATE_FORMATS: DateFormat[] = ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD', 'DD.MM.YYYY'];

// Scanner DNS is stored as a JSON-stringified array in the settings KV store
// (consistent with externalStackPaths). Tolerate the legacy/hand-edited
// comma-separated form too.
function parseScannerDnsStorage(raw: string | null | undefined): string[] {
	if (!raw) return [];
	const trimmed = raw.trim();
	if (!trimmed) return [];
	if (trimmed.startsWith('[')) {
		try {
			const parsed = JSON.parse(trimmed);
			return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
		} catch {
			return [];
		}
	}
	return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
}

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
			coloredActionButtons,
			actionIconSize,
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
			scannerCleanupCron,
			scannerCleanupEnabled,
			logBufferSizeKb,
			logMaxLines,
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
			compactPorts,
			showExposedPorts,
			formatLogTimestamps,
			externalStackPaths,
			primaryStackLocation,
			defaultGrypeImage,
			defaultTrivyImage,
			defaultComposeTemplate,
			labelFilterMode,
			honorProxyLabels,
			showImageChangelogLinks,
			animateIcons,
			protectScannerImages,
			defaultScannerNetworkMode,
			defaultScannerDnsRaw
		] = await Promise.all([
			getSetting('confirm_destructive'),
			getSetting('show_stopped_containers'),
			getSetting('highlight_updates'),
			getSetting('colored_action_buttons'),
			getSetting('action_icon_size'),
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
			getScannerCleanupCron(),
			getScannerCleanupEnabled(),
			getSetting('log_buffer_size_kb'),
			getSetting('log_max_lines'),
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
			getSetting('compact_ports'),
			getSetting('show_exposed_ports'),
			getSetting('format_log_timestamps'),
			getExternalStackPaths(),
			getPrimaryStackLocation(),
			getSetting('default_grype_image'),
			getSetting('default_trivy_image'),
			getSetting('default_compose_template'),
			getSetting('label_filter_mode'),
			getSetting('honor_proxy_labels'),
			getSetting('show_image_changelog_links'),
			getSetting('animate_icons'),
			getSetting('protect_scanner_images'),
			getSetting('default_scanner_network_mode'),
			getSetting('default_scanner_dns')
		]);

		const settings: GeneralSettings = {
			confirmDestructive: confirmDestructive ?? DEFAULT_SETTINGS.confirmDestructive,
			showStoppedContainers: showStoppedContainers ?? DEFAULT_SETTINGS.showStoppedContainers,
			highlightUpdates: highlightUpdates ?? DEFAULT_SETTINGS.highlightUpdates,
			coloredActionButtons: coloredActionButtons ?? DEFAULT_SETTINGS.coloredActionButtons,
			actionIconSize: (VALID_ACTION_ICON_SIZES.includes(actionIconSize as ActionIconSize) ? actionIconSize : DEFAULT_SETTINGS.actionIconSize) as ActionIconSize,
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
			scannerCleanupCron,
			scannerCleanupEnabled,
			logBufferSizeKb: logBufferSizeKb ?? DEFAULT_SETTINGS.logBufferSizeKb,
			logMaxLines: (typeof logMaxLines === 'number' && logMaxLines > 0)
				? Math.min(2000, Math.max(100, logMaxLines))
				: Math.min(2000, Math.max(100, Math.round((logBufferSizeKb ?? DEFAULT_SETTINGS.logBufferSizeKb) * 8))),
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
			compactPorts: compactPorts ?? DEFAULT_SETTINGS.compactPorts,
			showExposedPorts: showExposedPorts ?? DEFAULT_SETTINGS.showExposedPorts,
			formatLogTimestamps: formatLogTimestamps ?? DEFAULT_SETTINGS.formatLogTimestamps,
			externalStackPaths,
			primaryStackLocation,
			defaultGrypeImage: defaultGrypeImage ?? DEFAULT_GRYPE_IMAGE,
			defaultTrivyImage: defaultTrivyImage ?? DEFAULT_TRIVY_IMAGE,
			defaultComposeTemplate: defaultComposeTemplate ?? DEFAULT_SETTINGS.defaultComposeTemplate,
			labelFilterMode: labelFilterMode ?? DEFAULT_SETTINGS.labelFilterMode,
			honorProxyLabels: honorProxyLabels ?? DEFAULT_SETTINGS.honorProxyLabels,
			showImageChangelogLinks: showImageChangelogLinks ?? DEFAULT_SETTINGS.showImageChangelogLinks,
			animateIcons: animateIcons ?? DEFAULT_SETTINGS.animateIcons,
			protectScannerImages: protectScannerImages ?? DEFAULT_SETTINGS.protectScannerImages,
			defaultScannerNetworkMode: defaultScannerNetworkMode ?? DEFAULT_SETTINGS.defaultScannerNetworkMode,
			defaultScannerDns: parseScannerDnsStorage(defaultScannerDnsRaw)
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
		const { confirmDestructive, showStoppedContainers, highlightUpdates, coloredActionButtons, actionIconSize, timeFormat, dateFormat, downloadFormat, defaultGrypeArgs, defaultTrivyArgs, scheduleRetentionDays, eventRetentionDays, scheduleCleanupCron, eventCleanupCron, scheduleCleanupEnabled, eventCleanupEnabled, scannerCleanupCron, scannerCleanupEnabled, logBufferSizeKb, logMaxLines, defaultTimezone, eventCollectionMode, eventPollInterval, metricsCollectionInterval, lightTheme, darkTheme, font, fontSize, gridFontSize, terminalFont, editorFont, compactPorts, showExposedPorts, formatLogTimestamps, externalStackPaths, primaryStackLocation, defaultGrypeImage, defaultTrivyImage, defaultComposeTemplate, labelFilterMode, honorProxyLabels, showImageChangelogLinks, animateIcons, protectScannerImages, defaultScannerNetworkMode, defaultScannerDns } = body;

		if (confirmDestructive !== undefined) {
			await setSetting('confirm_destructive', confirmDestructive);
		}
		if (showStoppedContainers !== undefined) {
			await setSetting('show_stopped_containers', showStoppedContainers);
		}
		if (highlightUpdates !== undefined) {
			await setSetting('highlight_updates', highlightUpdates);
		}
		if (coloredActionButtons !== undefined) {
			await setSetting('colored_action_buttons', coloredActionButtons);
		}
		if (actionIconSize !== undefined && VALID_ACTION_ICON_SIZES.includes(actionIconSize)) {
			await setSetting('action_icon_size', actionIconSize);
		}
		if (timeFormat !== undefined && (timeFormat === '12h' || timeFormat === '24h')) {
			await setSetting('time_format', timeFormat);
		}
		if (dateFormat !== undefined && VALID_DATE_FORMATS.includes(dateFormat)) {
			await setSetting('date_format', dateFormat);
		}
		if (downloadFormat !== undefined && (downloadFormat === 'tar' || downloadFormat === 'tar.gz' || downloadFormat === 'raw')) {
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
		if (scannerCleanupCron !== undefined && typeof scannerCleanupCron === 'string') {
			await setScannerCleanupCron(scannerCleanupCron);
			await refreshSystemJobs();
		}
		if (scannerCleanupEnabled !== undefined && typeof scannerCleanupEnabled === 'boolean') {
			await setScannerCleanupEnabled(scannerCleanupEnabled);
			await refreshSystemJobs();
		}
		if (logBufferSizeKb !== undefined && typeof logBufferSizeKb === 'number') {
			// Legacy: clamp to 100KB-5MB range.
			await setSetting('log_buffer_size_kb', Math.max(100, Math.min(5000, logBufferSizeKb)));
		}
		if (logMaxLines !== undefined && typeof logMaxLines === 'number') {
			// Clamp to 100 - 50000 lines.
			await setSetting('log_max_lines', Math.max(100, Math.min(2000, logMaxLines)));
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
		if (compactPorts !== undefined) {
			await setSetting('compact_ports', compactPorts);
		}
		if (showExposedPorts !== undefined) {
			await setSetting('show_exposed_ports', showExposedPorts);
		}
		if (formatLogTimestamps !== undefined) {
			await setSetting('format_log_timestamps', formatLogTimestamps);
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
		if (defaultGrypeImage !== undefined && typeof defaultGrypeImage === 'string') {
			await setSetting('default_grype_image', defaultGrypeImage);
		}
		if (defaultTrivyImage !== undefined && typeof defaultTrivyImage === 'string') {
			await setSetting('default_trivy_image', defaultTrivyImage);
		}
		if (defaultComposeTemplate !== undefined && typeof defaultComposeTemplate === 'string') {
			await setSetting('default_compose_template', defaultComposeTemplate);
		}
		if (labelFilterMode !== undefined && (labelFilterMode === 'any' || labelFilterMode === 'all')) {
			await setSetting('label_filter_mode', labelFilterMode);
		}
		if (honorProxyLabels !== undefined && typeof honorProxyLabels === 'boolean') {
			await setSetting('honor_proxy_labels', honorProxyLabels);
		}
		if (showImageChangelogLinks !== undefined && typeof showImageChangelogLinks === 'boolean') {
			await setSetting('show_image_changelog_links', showImageChangelogLinks);
		}
		if (animateIcons !== undefined && typeof animateIcons === 'boolean') {
			await setSetting('animate_icons', animateIcons);
		}
		if (protectScannerImages !== undefined && typeof protectScannerImages === 'boolean') {
			await setSetting('protect_scanner_images', protectScannerImages);
		}
		if (defaultScannerNetworkMode !== undefined && typeof defaultScannerNetworkMode === 'string') {
			// Free-form network mode (host / bridge / none / custom-network-name / '').
			// Trim and cap length to avoid pathological values from a corrupted UI.
			const trimmed = defaultScannerNetworkMode.trim().slice(0, 200);
			await setSetting('default_scanner_network_mode', trimmed);
		}
		if (defaultScannerDns !== undefined && Array.isArray(defaultScannerDns)) {
			const cleaned = defaultScannerDns
				.filter((d) => typeof d === 'string')
				.map((d: string) => d.trim())
				.filter((d) => d.length > 0)
				.slice(0, 10); // sane upper bound; Docker accepts more but no one needs it
			await setSetting('default_scanner_dns', JSON.stringify(cleaned));
		}

		// Fetch all settings in parallel for the response
		const [
			confirmDestructiveVal,
			showStoppedContainersVal,
			highlightUpdatesVal,
			coloredActionButtonsVal,
			actionIconSizeVal,
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
			scannerCleanupCronVal,
			scannerCleanupEnabledVal,
			logBufferSizeKbVal,
			logMaxLinesVal,
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
			compactPortsVal,
			showExposedPortsVal,
			formatLogTimestampsVal,
			externalStackPathsVal,
			primaryStackLocationVal,
			defaultGrypeImageVal,
			defaultTrivyImageVal,
			defaultComposeTemplateVal,
			labelFilterModeVal,
			honorProxyLabelsVal,
			showImageChangelogLinksVal,
			animateIconsVal,
			protectScannerImagesVal,
			defaultScannerNetworkModeVal,
			defaultScannerDnsRawVal
		] = await Promise.all([
			getSetting('confirm_destructive'),
			getSetting('show_stopped_containers'),
			getSetting('highlight_updates'),
			getSetting('colored_action_buttons'),
			getSetting('action_icon_size'),
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
			getScannerCleanupCron(),
			getScannerCleanupEnabled(),
			getSetting('log_buffer_size_kb'),
			getSetting('log_max_lines'),
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
			getSetting('compact_ports'),
			getSetting('show_exposed_ports'),
			getSetting('format_log_timestamps'),
			getExternalStackPaths(),
			getPrimaryStackLocation(),
			getSetting('default_grype_image'),
			getSetting('default_trivy_image'),
			getSetting('default_compose_template'),
			getSetting('label_filter_mode'),
			getSetting('honor_proxy_labels'),
			getSetting('show_image_changelog_links'),
			getSetting('animate_icons'),
			getSetting('protect_scanner_images'),
			getSetting('default_scanner_network_mode'),
			getSetting('default_scanner_dns')
		]);

		const settings: GeneralSettings = {
			confirmDestructive: confirmDestructiveVal ?? DEFAULT_SETTINGS.confirmDestructive,
			showStoppedContainers: showStoppedContainersVal ?? DEFAULT_SETTINGS.showStoppedContainers,
			highlightUpdates: highlightUpdatesVal ?? DEFAULT_SETTINGS.highlightUpdates,
			coloredActionButtons: coloredActionButtonsVal ?? DEFAULT_SETTINGS.coloredActionButtons,
			actionIconSize: (VALID_ACTION_ICON_SIZES.includes(actionIconSizeVal as ActionIconSize) ? actionIconSizeVal : DEFAULT_SETTINGS.actionIconSize) as ActionIconSize,
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
			scannerCleanupCron: scannerCleanupCronVal,
			scannerCleanupEnabled: scannerCleanupEnabledVal,
			logBufferSizeKb: logBufferSizeKbVal ?? DEFAULT_SETTINGS.logBufferSizeKb,
			logMaxLines: (typeof logMaxLinesVal === 'number' && logMaxLinesVal > 0)
				? Math.min(2000, Math.max(100, logMaxLinesVal))
				: Math.min(2000, Math.max(100, Math.round((logBufferSizeKbVal ?? DEFAULT_SETTINGS.logBufferSizeKb) * 8))),
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
			compactPorts: compactPortsVal ?? DEFAULT_SETTINGS.compactPorts,
			showExposedPorts: showExposedPortsVal ?? DEFAULT_SETTINGS.showExposedPorts,
			formatLogTimestamps: formatLogTimestampsVal ?? DEFAULT_SETTINGS.formatLogTimestamps,
			externalStackPaths: externalStackPathsVal,
			primaryStackLocation: primaryStackLocationVal,
			defaultGrypeImage: defaultGrypeImageVal ?? DEFAULT_GRYPE_IMAGE,
			defaultTrivyImage: defaultTrivyImageVal ?? DEFAULT_TRIVY_IMAGE,
			defaultComposeTemplate: defaultComposeTemplateVal ?? DEFAULT_SETTINGS.defaultComposeTemplate,
			labelFilterMode: labelFilterModeVal ?? DEFAULT_SETTINGS.labelFilterMode,
			honorProxyLabels: honorProxyLabelsVal ?? DEFAULT_SETTINGS.honorProxyLabels,
			protectScannerImages: protectScannerImagesVal ?? DEFAULT_SETTINGS.protectScannerImages,
			showImageChangelogLinks: showImageChangelogLinksVal ?? DEFAULT_SETTINGS.showImageChangelogLinks,
			animateIcons: animateIconsVal ?? DEFAULT_SETTINGS.animateIcons,
			defaultScannerNetworkMode: defaultScannerNetworkModeVal ?? DEFAULT_SETTINGS.defaultScannerNetworkMode,
			defaultScannerDns: parseScannerDnsStorage(defaultScannerDnsRawVal)
		};

		return json(settings);
	} catch (error) {
		console.error('Failed to save general settings:', error);
		return json({ error: 'Failed to save general settings' }, { status: 500 });
	}
};
