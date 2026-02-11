/**
 * Theme Store for Dockhand
 *
 * Manages theme and font preferences with:
 * - Immediate application (no page reload)
 * - localStorage sync for flash-free loading
 * - Database persistence via API
 */

import { writable, get } from 'svelte/store';
import { getFont, getMonospaceFont, type FontMeta } from '$lib/themes';

export type FontSize = 'xsmall' | 'small' | 'normal' | 'medium' | 'large' | 'xlarge';

export interface ThemePreferences {
	lightTheme: string;
	darkTheme: string;
	font: string;
	fontSize: FontSize;
	gridFontSize: FontSize;
	terminalFont: string;
	editorFont: string;
}

const STORAGE_KEY = 'dockhand-theme';

const defaultPrefs: ThemePreferences = {
	lightTheme: 'default',
	darkTheme: 'default',
	font: 'system',
	fontSize: 'normal',
	gridFontSize: 'normal',
	terminalFont: 'system-mono',
	editorFont: 'system-mono'
};

// Font size scale mapping
const fontSizeScales: Record<FontSize, number> = {
	xsmall: 0.75,
	small: 0.875,
	normal: 1.0,
	medium: 1.0625,
	large: 1.125,
	xlarge: 1.25
};

// Grid font size scale - independent scaling for data grids
const gridFontSizeScales: Record<FontSize, number> = {
	xsmall: 0.7,
	small: 0.85,
	normal: 1.0,
	medium: 1.15,
	large: 1.35,
	xlarge: 1.7
};

// Load initial state from localStorage (for flash-free loading)
function loadFromStorage(): ThemePreferences {
	if (typeof window === 'undefined') return defaultPrefs;

	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored) {
			return { ...defaultPrefs, ...JSON.parse(stored) };
		}
	} catch {
		// Ignore parse errors
	}
	return defaultPrefs;
}

// Create the store
function createThemeStore() {
	const initialPrefs = loadFromStorage();
	const { subscribe, set, update } = writable<ThemePreferences>(initialPrefs);

	// Apply theme immediately on store creation (for flash-free loading)
	if (typeof document !== 'undefined') {
		applyTheme(initialPrefs);
	}

	return {
		subscribe,

		// Initialize from API (called on mount)
		async init(userId?: number) {
			try {
				// Use profile preferences for authenticated users, public theme endpoint otherwise
				const url = userId
					? `/api/profile/preferences`
					: `/api/settings/theme`;

				const res = await fetch(url);
				if (res.ok) {
					const data = await res.json();
					const prefs: ThemePreferences = {
						lightTheme: data.lightTheme || data.theme_light || 'default',
						darkTheme: data.darkTheme || data.theme_dark || 'default',
						font: data.font || data.theme_font || 'system',
						fontSize: data.fontSize || data.font_size || 'normal',
						gridFontSize: data.gridFontSize || data.grid_font_size || 'normal',
						terminalFont: data.terminalFont || data.terminal_font || 'system-mono',
						editorFont: data.editorFont || data.editor_font || 'system-mono'
					};
					set(prefs);
					saveToStorage(prefs);
					applyTheme(prefs);
				}
			} catch {
				// Use localStorage fallback
				const prefs = loadFromStorage();
				applyTheme(prefs);
			}
		},

		// Update a preference and optionally apply immediately
		// skipApply: when true, saves to database but doesn't apply visually (for global settings when user is logged in)
		async setPreference<K extends keyof ThemePreferences>(
			key: K,
			value: ThemePreferences[K],
			userId?: number,
			skipApply?: boolean
		) {
			if (!skipApply) {
				update((prefs) => {
					const newPrefs = { ...prefs, [key]: value };
					saveToStorage(newPrefs);
					applyTheme(newPrefs);
					return newPrefs;
				});
			}

			// Save to database (async, non-blocking)
			try {
				const url = userId
					? `/api/profile/preferences`
					: `/api/settings/general`;

				await fetch(url, {
					method: userId ? 'PUT' : 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ [key]: value })
				});
			} catch {
				// Silently fail - localStorage has the value
			}
		},

		// Get current preferences
		get(): ThemePreferences {
			return get({ subscribe });
		}
	};
}

// Save to localStorage
function saveToStorage(prefs: ThemePreferences) {
	if (typeof window === 'undefined') return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
	} catch {
		// Ignore storage errors
	}
}

// Apply theme to document
export function applyTheme(prefs: ThemePreferences) {
	if (typeof document === 'undefined') return;

	const root = document.documentElement;
	const isDark = root.classList.contains('dark');

	// Remove all theme classes
	root.classList.forEach((cls) => {
		if (cls.startsWith('theme-light-') || cls.startsWith('theme-dark-')) {
			root.classList.remove(cls);
		}
	});

	// Apply the appropriate theme class
	if (isDark && prefs.darkTheme !== 'default') {
		root.classList.add(`theme-dark-${prefs.darkTheme}`);
	} else if (!isDark && prefs.lightTheme !== 'default') {
		root.classList.add(`theme-light-${prefs.lightTheme}`);
	}

	// Apply font
	applyFont(prefs.font);

	// Apply font size
	applyFontSize(prefs.fontSize);

	// Apply grid font size
	applyGridFontSize(prefs.gridFontSize);

	// Apply terminal font
	applyTerminalFont(prefs.terminalFont);

	// Apply editor font
	applyEditorFont(prefs.editorFont);
}

// Apply font to document
function applyFont(fontId: string) {
	if (typeof document === 'undefined') return;

	const fontMeta = getFont(fontId);
	if (!fontMeta) return;

	// Load Google Font if needed
	if (fontMeta.googleFont) {
		loadGoogleFont(fontMeta);
	}

	// Set CSS variable
	document.documentElement.style.setProperty('--font-sans', fontMeta.family);
}

// Apply font size to document
function applyFontSize(fontSize: FontSize) {
	if (typeof document === 'undefined') return;

	const scale = fontSizeScales[fontSize] || 1.0;
	document.documentElement.style.setProperty('--font-size-scale', scale.toString());
}

// Apply grid font size to document
function applyGridFontSize(gridFontSize: FontSize) {
	if (typeof document === 'undefined') return;

	const gridScale = gridFontSizeScales[gridFontSize] || 1.0;
	document.documentElement.style.setProperty('--grid-font-size-scale', gridScale.toString());
}

// Apply terminal font to document
function applyTerminalFont(fontId: string) {
	if (typeof document === 'undefined') return;

	const fontMeta = getMonospaceFont(fontId);
	if (!fontMeta) return;

	// Load Google Font if needed
	if (fontMeta.googleFont) {
		loadGoogleFont(fontMeta);
	}

	// Set CSS variable
	document.documentElement.style.setProperty('--font-mono', fontMeta.family);
}

// Apply editor font to document
function applyEditorFont(fontId: string) {
	if (typeof document === 'undefined') return;

	const fontMeta = getMonospaceFont(fontId);
	if (!fontMeta) return;

	// Load Google Font if needed
	if (fontMeta.googleFont) {
		loadGoogleFont(fontMeta);
	}

	// Set CSS variable
	document.documentElement.style.setProperty('--font-editor', fontMeta.family);
}

// Load Google Font dynamically
function loadGoogleFont(font: FontMeta) {
	if (!font.googleFont) return;

	const linkId = `google-font-${font.id}`;
	if (document.getElementById(linkId)) return; // Already loaded

	const link = document.createElement('link');
	link.id = linkId;
	link.rel = 'stylesheet';
	link.href = `https://fonts.googleapis.com/css2?family=${font.googleFont}&display=swap`;
	document.head.appendChild(link);
}

// Re-apply theme when dark mode toggles
export function onDarkModeChange() {
	const prefs = themeStore.get();
	applyTheme(prefs);
}

export const themeStore = createThemeStore();
