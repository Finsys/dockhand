import { writable, derived, get } from 'svelte/store';
import { browser } from '$app/environment';

export type TimeFormat = '12h' | '24h';
export type DateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'DD.MM.YYYY';
export type DownloadFormat = 'tar' | 'tar.gz';
export type EventCollectionMode = 'stream' | 'poll';

export interface AppSettings {
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
	eventCollectionMode: EventCollectionMode;
	eventPollInterval: number;
	metricsCollectionInterval: number;
	externalStackPaths: string[];
	primaryStackLocation: string | null;
	defaultComposeTemplate: string;
}

const DEFAULT_SETTINGS: AppSettings = {
	confirmDestructive: true,
	showStoppedContainers: true,
	highlightUpdates: true,
	timeFormat: '24h',
	dateFormat: 'DD.MM.YYYY',
	downloadFormat: 'tar',
	defaultGrypeArgs: '-o json -v {image}',
	defaultTrivyArgs: 'image --format json {image}',
	scheduleRetentionDays: 30,
	eventRetentionDays: 30,
	scheduleCleanupCron: '0 3 * * *',
	eventCleanupCron: '30 3 * * *',
	scheduleCleanupEnabled: true,
	eventCleanupEnabled: true,
	logBufferSizeKb: 500,
	defaultTimezone: 'UTC',
	eventCollectionMode: 'stream',
	eventPollInterval: 60000,
	metricsCollectionInterval: 30000,
	externalStackPaths: [],
	primaryStackLocation: null,
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

// Create a writable store for app settings
function createSettingsStore() {
	const { subscribe, set, update } = writable<AppSettings>(DEFAULT_SETTINGS);
	let initialized = false;

	// Load settings from database on initialization
	async function loadSettings() {
		if (!browser || initialized) return;
		initialized = true;

		try {
			const response = await fetch('/api/settings/general');
			if (response.ok) {
				const settings = await response.json();
				set({
					confirmDestructive: settings.confirmDestructive ?? DEFAULT_SETTINGS.confirmDestructive,
					showStoppedContainers: settings.showStoppedContainers ?? DEFAULT_SETTINGS.showStoppedContainers,
					highlightUpdates: settings.highlightUpdates ?? DEFAULT_SETTINGS.highlightUpdates,
					timeFormat: settings.timeFormat ?? DEFAULT_SETTINGS.timeFormat,
					dateFormat: settings.dateFormat ?? DEFAULT_SETTINGS.dateFormat,
					downloadFormat: settings.downloadFormat ?? DEFAULT_SETTINGS.downloadFormat,
					defaultGrypeArgs: settings.defaultGrypeArgs ?? DEFAULT_SETTINGS.defaultGrypeArgs,
					defaultTrivyArgs: settings.defaultTrivyArgs ?? DEFAULT_SETTINGS.defaultTrivyArgs,
					scheduleRetentionDays: settings.scheduleRetentionDays ?? DEFAULT_SETTINGS.scheduleRetentionDays,
					eventRetentionDays: settings.eventRetentionDays ?? DEFAULT_SETTINGS.eventRetentionDays,
					scheduleCleanupCron: settings.scheduleCleanupCron ?? DEFAULT_SETTINGS.scheduleCleanupCron,
					eventCleanupCron: settings.eventCleanupCron ?? DEFAULT_SETTINGS.eventCleanupCron,
					scheduleCleanupEnabled: settings.scheduleCleanupEnabled ?? DEFAULT_SETTINGS.scheduleCleanupEnabled,
					eventCleanupEnabled: settings.eventCleanupEnabled ?? DEFAULT_SETTINGS.eventCleanupEnabled,
					logBufferSizeKb: settings.logBufferSizeKb ?? DEFAULT_SETTINGS.logBufferSizeKb,
					defaultTimezone: settings.defaultTimezone ?? DEFAULT_SETTINGS.defaultTimezone,
					eventCollectionMode: settings.eventCollectionMode ?? DEFAULT_SETTINGS.eventCollectionMode,
					eventPollInterval: settings.eventPollInterval ?? DEFAULT_SETTINGS.eventPollInterval,
					metricsCollectionInterval: settings.metricsCollectionInterval ?? DEFAULT_SETTINGS.metricsCollectionInterval,
					externalStackPaths: settings.externalStackPaths ?? DEFAULT_SETTINGS.externalStackPaths,
					primaryStackLocation: settings.primaryStackLocation ?? DEFAULT_SETTINGS.primaryStackLocation,
					defaultComposeTemplate: settings.defaultComposeTemplate ?? DEFAULT_SETTINGS.defaultComposeTemplate
				});
			}
		} catch {
			// Silently use defaults if settings can't be loaded
		}
	}

	// Save settings to database
	async function saveSettings(settings: Partial<AppSettings>) {
		if (!browser) return;

		try {
			const response = await fetch('/api/settings/general', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(settings)
			});
			if (response.ok) {
				const updatedSettings = await response.json();
				set({
					confirmDestructive: updatedSettings.confirmDestructive ?? DEFAULT_SETTINGS.confirmDestructive,
					showStoppedContainers: updatedSettings.showStoppedContainers ?? DEFAULT_SETTINGS.showStoppedContainers,
					highlightUpdates: updatedSettings.highlightUpdates ?? DEFAULT_SETTINGS.highlightUpdates,
					timeFormat: updatedSettings.timeFormat ?? DEFAULT_SETTINGS.timeFormat,
					dateFormat: updatedSettings.dateFormat ?? DEFAULT_SETTINGS.dateFormat,
					downloadFormat: updatedSettings.downloadFormat ?? DEFAULT_SETTINGS.downloadFormat,
					defaultGrypeArgs: updatedSettings.defaultGrypeArgs ?? DEFAULT_SETTINGS.defaultGrypeArgs,
					defaultTrivyArgs: updatedSettings.defaultTrivyArgs ?? DEFAULT_SETTINGS.defaultTrivyArgs,
					scheduleRetentionDays: updatedSettings.scheduleRetentionDays ?? DEFAULT_SETTINGS.scheduleRetentionDays,
					eventRetentionDays: updatedSettings.eventRetentionDays ?? DEFAULT_SETTINGS.eventRetentionDays,
					scheduleCleanupCron: updatedSettings.scheduleCleanupCron ?? DEFAULT_SETTINGS.scheduleCleanupCron,
					eventCleanupCron: updatedSettings.eventCleanupCron ?? DEFAULT_SETTINGS.eventCleanupCron,
					scheduleCleanupEnabled: updatedSettings.scheduleCleanupEnabled ?? DEFAULT_SETTINGS.scheduleCleanupEnabled,
					eventCleanupEnabled: updatedSettings.eventCleanupEnabled ?? DEFAULT_SETTINGS.eventCleanupEnabled,
					logBufferSizeKb: updatedSettings.logBufferSizeKb ?? DEFAULT_SETTINGS.logBufferSizeKb,
					defaultTimezone: updatedSettings.defaultTimezone ?? DEFAULT_SETTINGS.defaultTimezone,
					eventCollectionMode: updatedSettings.eventCollectionMode ?? DEFAULT_SETTINGS.eventCollectionMode,
					eventPollInterval: updatedSettings.eventPollInterval ?? DEFAULT_SETTINGS.eventPollInterval,
					metricsCollectionInterval: updatedSettings.metricsCollectionInterval ?? DEFAULT_SETTINGS.metricsCollectionInterval,
					externalStackPaths: updatedSettings.externalStackPaths ?? DEFAULT_SETTINGS.externalStackPaths,
					primaryStackLocation: updatedSettings.primaryStackLocation ?? DEFAULT_SETTINGS.primaryStackLocation,
					defaultComposeTemplate: updatedSettings.defaultComposeTemplate ?? DEFAULT_SETTINGS.defaultComposeTemplate
				});
			}
		} catch (error) {
			console.error('Failed to save settings:', error);
		}
	}

	// Load settings on store creation
	if (browser) {
		loadSettings();
	}

	return {
		subscribe,
		set: (value: AppSettings) => {
			set(value);
			saveSettings(value);
		},
		update: (fn: (settings: AppSettings) => AppSettings) => {
			update((current) => {
				const newSettings = fn(current);
				saveSettings(newSettings);
				return newSettings;
			});
		},
		// Convenience methods for individual settings
		setConfirmDestructive: (value: boolean) => {
			update((current) => {
				const newSettings = { ...current, confirmDestructive: value };
				saveSettings({ confirmDestructive: value });
				return newSettings;
			});
		},
		setShowStoppedContainers: (value: boolean) => {
			update((current) => {
				const newSettings = { ...current, showStoppedContainers: value };
				saveSettings({ showStoppedContainers: value });
				return newSettings;
			});
		},
		setHighlightUpdates: (value: boolean) => {
			update((current) => {
				const newSettings = { ...current, highlightUpdates: value };
				saveSettings({ highlightUpdates: value });
				return newSettings;
			});
		},
		setTimeFormat: (value: TimeFormat) => {
			update((current) => {
				const newSettings = { ...current, timeFormat: value };
				saveSettings({ timeFormat: value });
				return newSettings;
			});
		},
		setDateFormat: (value: DateFormat) => {
			update((current) => {
				const newSettings = { ...current, dateFormat: value };
				saveSettings({ dateFormat: value });
				return newSettings;
			});
		},
		setDownloadFormat: (value: DownloadFormat) => {
			update((current) => {
				const newSettings = { ...current, downloadFormat: value };
				saveSettings({ downloadFormat: value });
				return newSettings;
			});
		},
		setDefaultGrypeArgs: (value: string) => {
			update((current) => {
				const newSettings = { ...current, defaultGrypeArgs: value };
				saveSettings({ defaultGrypeArgs: value });
				return newSettings;
			});
		},
		setDefaultTrivyArgs: (value: string) => {
			update((current) => {
				const newSettings = { ...current, defaultTrivyArgs: value };
				saveSettings({ defaultTrivyArgs: value });
				return newSettings;
			});
		},
		setScheduleRetentionDays: (value: number) => {
			update((current) => {
				const newSettings = { ...current, scheduleRetentionDays: value };
				saveSettings({ scheduleRetentionDays: value });
				return newSettings;
			});
		},
		setEventRetentionDays: (value: number) => {
			update((current) => {
				const newSettings = { ...current, eventRetentionDays: value };
				saveSettings({ eventRetentionDays: value });
				return newSettings;
			});
		},
		setScheduleCleanupCron: (value: string) => {
			update((current) => {
				const newSettings = { ...current, scheduleCleanupCron: value };
				saveSettings({ scheduleCleanupCron: value });
				return newSettings;
			});
		},
		setEventCleanupCron: (value: string) => {
			update((current) => {
				const newSettings = { ...current, eventCleanupCron: value };
				saveSettings({ eventCleanupCron: value });
				return newSettings;
			});
		},
		setScheduleCleanupEnabled: (value: boolean) => {
			update((current) => {
				const newSettings = { ...current, scheduleCleanupEnabled: value };
				saveSettings({ scheduleCleanupEnabled: value });
				return newSettings;
			});
		},
		setEventCleanupEnabled: (value: boolean) => {
			update((current) => {
				const newSettings = { ...current, eventCleanupEnabled: value };
				saveSettings({ eventCleanupEnabled: value });
				return newSettings;
			});
		},
		setLogBufferSizeKb: (value: number) => {
			update((current) => {
				const newSettings = { ...current, logBufferSizeKb: value };
				saveSettings({ logBufferSizeKb: value });
				return newSettings;
			});
		},
		setDefaultTimezone: (value: string) => {
			update((current) => {
				const newSettings = { ...current, defaultTimezone: value };
				saveSettings({ defaultTimezone: value });
				return newSettings;
			});
		},
		setEventCollectionMode: (value: EventCollectionMode) => {
			update((current) => {
				const newSettings = { ...current, eventCollectionMode: value };
				saveSettings({ eventCollectionMode: value });
				return newSettings;
			});
		},
		setEventPollInterval: (value: number) => {
			update((current) => {
				const newSettings = { ...current, eventPollInterval: value };
				saveSettings({ eventPollInterval: value });
				return newSettings;
			});
		},
		setMetricsCollectionInterval: (value: number) => {
			update((current) => {
				const newSettings = { ...current, metricsCollectionInterval: value };
				saveSettings({ metricsCollectionInterval: value });
				return newSettings;
			});
		},
		setExternalStackPaths: (value: string[]) => {
			update((current) => {
				const newSettings = { ...current, externalStackPaths: value };
				saveSettings({ externalStackPaths: value });
				return newSettings;
			});
		},
		setPrimaryStackLocation: (value: string | null) => {
			update((current) => {
				const newSettings = { ...current, primaryStackLocation: value };
				saveSettings({ primaryStackLocation: value });
				return newSettings;
			});
		},
		setDefaultComposeTemplate: (value: string) => {
			update((current) => {
				const newSettings = { ...current, defaultComposeTemplate: value };
				saveSettings({ defaultComposeTemplate: value });
				return newSettings;
			});
		},
		// Manual refresh from database
		refresh: loadSettings
	};
}

export const appSettings = createSettingsStore();

// Cache current settings for synchronous access (updated reactively)
let cachedTimeFormat: TimeFormat = DEFAULT_SETTINGS.timeFormat;
let cachedDateFormat: DateFormat = DEFAULT_SETTINGS.dateFormat;

// Subscribe once to keep cache updated
if (browser) {
	appSettings.subscribe((s) => {
		cachedTimeFormat = s.timeFormat;
		cachedDateFormat = s.dateFormat;
	});
}

/**
 * Format a date part according to user's date format preference.
 * This is a low-level helper - prefer formatDateTime for most uses.
 */
function formatDatePart(d: Date): string {
	const day = d.getDate().toString().padStart(2, '0');
	const month = (d.getMonth() + 1).toString().padStart(2, '0');
	const year = d.getFullYear();

	switch (cachedDateFormat) {
		case 'MM/DD/YYYY':
			return `${month}/${day}/${year}`;
		case 'DD/MM/YYYY':
			return `${day}/${month}/${year}`;
		case 'YYYY-MM-DD':
			return `${year}-${month}-${day}`;
		case 'DD.MM.YYYY':
		default:
			return `${day}.${month}.${year}`;
	}
}

/**
 * Format a time part according to user's time format preference.
 * This is a low-level helper - prefer formatDateTime for most uses.
 */
function formatTimePart(d: Date, includeSeconds = false): string {
	const hours = d.getHours();
	const minutes = d.getMinutes().toString().padStart(2, '0');
	const seconds = d.getSeconds().toString().padStart(2, '0');

	if (cachedTimeFormat === '12h') {
		const hour12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
		const ampm = hours >= 12 ? 'PM' : 'AM';
		return includeSeconds
			? `${hour12}:${minutes}:${seconds} ${ampm}`
			: `${hour12}:${minutes} ${ampm}`;
	} else {
		const hour24 = hours.toString().padStart(2, '0');
		return includeSeconds
			? `${hour24}:${minutes}:${seconds}`
			: `${hour24}:${minutes}`;
	}
}

/**
 * Format a timestamp according to user's time and date format preferences.
 * Performant: uses cached settings, no store subscription per call.
 *
 * @param date - Date object, ISO string, or timestamp
 * @param options - Formatting options
 * @returns Formatted string
 */
export function formatTime(
	date: Date | string | number,
	options: { includeDate?: boolean; includeSeconds?: boolean } = {}
): string {
	const d = date instanceof Date ? date : new Date(date);
	const { includeDate = false, includeSeconds = false } = options;

	if (includeDate) {
		return `${formatDatePart(d)} ${formatTimePart(d, includeSeconds)}`;
	}

	return formatTimePart(d, includeSeconds);
}

/**
 * Format a timestamp with date according to user's preferences.
 * Convenience wrapper around formatTime.
 */
export function formatDateTime(date: Date | string | number, includeSeconds = false): string {
	return formatTime(date, { includeDate: true, includeSeconds });
}

/**
 * Format just the date part according to user's preferences.
 */
export function formatDate(date: Date | string | number): string {
	const d = date instanceof Date ? date : new Date(date);
	return formatDatePart(d);
}

/**
 * Get the current time format setting (for components that need it).
 */
export function getTimeFormat(): TimeFormat {
	return cachedTimeFormat;
}

/**
 * Get the current date format setting (for components that need it).
 */
export function getDateFormat(): DateFormat {
	return cachedDateFormat;
}
