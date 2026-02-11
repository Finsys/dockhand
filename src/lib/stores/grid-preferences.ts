/**
 * Grid Preferences Store for Dockhand
 *
 * Manages column visibility and ordering preferences with:
 * - localStorage sync for flash-free loading
 * - Database persistence via API
 * - Per-grid configuration
 */

import { writable, get } from 'svelte/store';
import type { AllGridPreferences, GridId, ColumnPreference, GridColumnPreferences } from '$lib/types';
import { getDefaultColumnPreferences, getConfigurableColumns } from '$lib/config/grid-columns';

const STORAGE_KEY = 'dockhand-grid-preferences';

// Load initial state from localStorage
function loadFromStorage(): AllGridPreferences {
	if (typeof window === 'undefined') return {};

	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored) {
			return JSON.parse(stored);
		}
	} catch {
		// Ignore parse errors
	}
	return {};
}

// Save to localStorage
function saveToStorage(prefs: AllGridPreferences) {
	if (typeof window === 'undefined') return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
	} catch {
		// Ignore storage errors
	}
}

// Create the store
function createGridPreferencesStore() {
	const { subscribe, set, update } = writable<AllGridPreferences>(loadFromStorage());

	return {
		subscribe,

		// Initialize from API (called on mount)
		async init() {
			try {
				const res = await fetch('/api/preferences/grid');
				if (res.ok) {
					const data = await res.json();
					const prefs = data.preferences || {};
					set(prefs);
					saveToStorage(prefs);
				}
			} catch {
				// Use localStorage fallback
			}
		},

		// Get visible columns for a grid (in order)
		getVisibleColumns(gridId: GridId): ColumnPreference[] {
			const prefs = get({ subscribe });
			const gridPrefs = prefs[gridId];

			if (!gridPrefs?.columns?.length) {
				// Return defaults (all visible)
				return getDefaultColumnPreferences(gridId);
			}

			// Merge with defaults to ensure new columns are included
			const defaults = getDefaultColumnPreferences(gridId);
			const savedIds = new Set(gridPrefs.columns.map((c) => c.id));

			// Start with saved visible columns
			const result = gridPrefs.columns.filter((col) => col.visible);

			// Add any new default columns that aren't in saved preferences
			for (const def of defaults) {
				if (!savedIds.has(def.id) && def.visible) {
					result.push(def);
				}
			}

			return result;
		},

		// Get all columns for a grid (visible and hidden, in order)
		getAllColumns(gridId: GridId): ColumnPreference[] {
			const prefs = get({ subscribe });
			const gridPrefs = prefs[gridId];

			if (!gridPrefs?.columns?.length) {
				// Return defaults (all visible)
				return getDefaultColumnPreferences(gridId);
			}

			// Merge with defaults to ensure new columns are included
			const defaults = getDefaultColumnPreferences(gridId);
			const savedIds = new Set(gridPrefs.columns.map((c) => c.id));

			// Start with saved columns, then add any new defaults
			const result = [...gridPrefs.columns];
			for (const def of defaults) {
				if (!savedIds.has(def.id)) {
					result.push(def);
				}
			}

			return result;
		},

		// Check if a specific column is visible
		isColumnVisible(gridId: GridId, columnId: string): boolean {
			const prefs = get({ subscribe });
			const gridPrefs = prefs[gridId];

			if (!gridPrefs?.columns?.length) {
				// Defaults to visible
				return true;
			}

			const col = gridPrefs.columns.find((c) => c.id === columnId);
			return col ? col.visible : true;
		},

		// Update column visibility/order for a grid
		async setColumns(gridId: GridId, columns: ColumnPreference[]) {
			update((prefs) => {
				const newPrefs = {
					...prefs,
					[gridId]: { columns }
				};
				saveToStorage(newPrefs);
				return newPrefs;
			});

			// Save to database (async, non-blocking)
			try {
				await fetch('/api/preferences/grid', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ gridId, columns })
				});
			} catch {
				// Silently fail - localStorage has the value
			}
		},

		// Toggle a column's visibility
		async toggleColumn(gridId: GridId, columnId: string) {
			const allCols = this.getAllColumns(gridId);
			const newColumns = allCols.map((col) =>
				col.id === columnId ? { ...col, visible: !col.visible } : col
			);
			await this.setColumns(gridId, newColumns);
		},

		// Reset a grid to default columns
		async resetGrid(gridId: GridId) {
			const defaults = getDefaultColumnPreferences(gridId);

			update((prefs) => {
				const newPrefs = { ...prefs };
				delete newPrefs[gridId];
				saveToStorage(newPrefs);
				return newPrefs;
			});

			// Delete from database
			try {
				await fetch(`/api/preferences/grid?gridId=${gridId}`, {
					method: 'DELETE'
				});
			} catch {
				// Silently fail
			}
		},

		// Get ordered column IDs for rendering
		getColumnOrder(gridId: GridId): string[] {
			const allCols = this.getAllColumns(gridId);
			return allCols.filter((c) => c.visible).map((c) => c.id);
		},

		// Get saved width for a specific column
		getColumnWidth(gridId: GridId, columnId: string): number | undefined {
			const prefs = get({ subscribe });
			const gridPrefs = prefs[gridId];
			if (!gridPrefs?.columns?.length) return undefined;
			const col = gridPrefs.columns.find((c) => c.id === columnId);
			return col?.width;
		},

		// Get all saved widths as a Map
		getColumnWidths(gridId: GridId): Map<string, number> {
			const prefs = get({ subscribe });
			const gridPrefs = prefs[gridId];
			const widths = new Map<string, number>();
			if (gridPrefs?.columns) {
				for (const col of gridPrefs.columns) {
					if (col.width !== undefined) {
						widths.set(col.id, col.width);
					}
				}
			}
			return widths;
		},

		// Set width for a specific column (works for both configurable and fixed columns)
		async setColumnWidth(gridId: GridId, columnId: string, width: number) {
			const allCols = this.getAllColumns(gridId);
			let found = false;
			const newColumns = allCols.map((col) => {
				if (col.id === columnId) {
					found = true;
					return { ...col, width };
				}
				return col;
			});

			// If column wasn't found (e.g., fixed column), add it
			if (!found) {
				newColumns.push({ id: columnId, visible: true, width });
			}

			await this.setColumns(gridId, newColumns);
		},

		// Get current preferences
		get(): AllGridPreferences {
			return get({ subscribe });
		}
	};
}

export const gridPreferencesStore = createGridPreferencesStore();
