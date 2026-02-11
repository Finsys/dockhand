import { writable, get } from 'svelte/store';
import type { EnvironmentStats } from '../../routes/api/dashboard/stats/+server';

// Grid item layout format for svelte-grid
export interface GridItem {
	id: number;
	x: number;
	y: number;
	w: number;
	h: number;
	[key: string]: unknown; // Allow svelte-grid internal properties
}

export interface DashboardPreferences {
	gridLayout: GridItem[];
}

const defaultPreferences: DashboardPreferences = {
	gridLayout: []
};

// Environment info from API
interface EnvironmentInfo {
	id: number;
	name: string;
	host?: string;
	icon: string;
	socketPath?: string;
	connectionType?: 'socket' | 'direct' | 'hawser-standard' | 'hawser-edge';
}

// Metrics history point for charts
export interface MetricsHistoryPoint {
	cpu_percent: number;
	memory_percent: number;
	timestamp: string;
}

// Tile item combining environment info and stats
export interface TileItem {
	id: number;
	stats: EnvironmentStats | null;
	info: EnvironmentInfo | null;
	loading: boolean;
}

// Dashboard data store for caching between navigations
export interface DashboardData {
	tiles: TileItem[];
	gridItems: GridItem[];
	lastFetchTime: number | null;
	initialized: boolean;
}

const defaultDashboardData: DashboardData = {
	tiles: [],
	gridItems: [],
	lastFetchTime: null,
	initialized: false
};

function createDashboardDataStore() {
	const { subscribe, set, update } = writable<DashboardData>(defaultDashboardData);

	return {
		subscribe,
		setTiles: (tiles: TileItem[]) => {
			update(data => ({ ...data, tiles, lastFetchTime: Date.now() }));
		},
		updateTile: (id: number, updates: Partial<TileItem>) => {
			update(data => ({
				...data,
				tiles: data.tiles.map(t => t.id === id ? { ...t, ...updates } : t),
				lastFetchTime: Date.now()
			}));
		},
		// Partial update for progressive loading - deep merges into existing stats
		// This preserves nested object properties (like containers.pendingUpdates)
		updateTilePartial: (id: number, partialStats: Partial<EnvironmentStats>) => {
			update(data => ({
				...data,
				tiles: data.tiles.map(t => {
					if (t.id === id && t.stats) {
						// Deep merge: for nested objects, merge properties instead of replacing
						const mergedStats = { ...t.stats };
						for (const [key, value] of Object.entries(partialStats)) {
							const existing = (mergedStats as any)[key];
							// Deep merge for plain objects (not arrays or null)
							if (existing && typeof existing === 'object' && !Array.isArray(existing) &&
							    value && typeof value === 'object' && !Array.isArray(value)) {
								(mergedStats as any)[key] = { ...existing, ...value };
							} else if (value !== undefined) {
								(mergedStats as any)[key] = value;
							}
						}
						return { ...t, stats: mergedStats };
					}
					return t;
				}),
				lastFetchTime: Date.now()
			}));
		},
		setGridItems: (gridItems: GridItem[]) => {
			update(data => ({ ...data, gridItems }));
		},
		setInitialized: (initialized: boolean) => {
			update(data => ({ ...data, initialized }));
		},
		markAllLoading: () => {
			update(data => ({
				...data,
				tiles: data.tiles.map(t => ({ ...t, loading: true }))
			}));
		},
		// Invalidate cache to force a fresh fetch on next dashboard visit
		// Clear tiles so dashboard starts fresh with new data
		invalidate: () => {
			update(data => ({
				...data,
				tiles: [],
				lastFetchTime: null,
				initialized: false
			}));
		},
		reset: () => set(defaultDashboardData),
		getData: () => get({ subscribe })
	};
}

export const dashboardData = createDashboardDataStore();

// Number of columns in the grid
export const GRID_COLS = 4;
// Row height for tiles - compact tiles (h=1) show basic info, larger tiles show more
// At height=2 (default), should fit: header, container counts, health, CPU/mem, resources, events
export const GRID_ROW_HEIGHT = 175;

function createDashboardStore() {
	const { subscribe, set, update } = writable<DashboardPreferences>(defaultPreferences);
	let saveTimeout: ReturnType<typeof setTimeout> | null = null;
	let initialized = false;

	async function load() {
		try {
			const response = await fetch('/api/dashboard/preferences');
			if (response.ok) {
				const data = await response.json();
				// Handle migration from old format
				if (data.gridLayout && Array.isArray(data.gridLayout)) {
					set({ gridLayout: data.gridLayout });
				} else {
					set({ gridLayout: [] });
				}
			} else {
				set({ gridLayout: [] });
			}
		} catch (error) {
			console.error('Failed to load dashboard preferences:', error);
			set({ gridLayout: [] });
		} finally {
			// Always mark as initialized so saves can proceed
			initialized = true;
		}
	}

	async function save(prefs: DashboardPreferences) {
		try {
			await fetch('/api/dashboard/preferences', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(prefs)
			});
		} catch (error) {
			console.error('Failed to save dashboard preferences:', error);
		}
	}

	// Debounced save - auto-saves 500ms after last change
	function scheduleSave(prefs: DashboardPreferences) {
		if (saveTimeout) {
			clearTimeout(saveTimeout);
		}
		saveTimeout = setTimeout(() => {
			save(prefs);
			saveTimeout = null;
		}, 500);
	}

	return {
		subscribe,
		load,
		setGridLayout: (layout: GridItem[]) => {
			update(prefs => {
				// Only keep essential properties to avoid storing internal svelte-grid state
				const cleanLayout = layout.map(item => ({
					id: item.id,
					x: item.x,
					y: item.y,
					w: item.w,
					h: item.h
				}));
				const newPrefs = { ...prefs, gridLayout: cleanLayout };
				if (initialized) {
					scheduleSave(newPrefs);
				}
				return newPrefs;
			});
		},
		reset: () => {
			initialized = false;
			set(defaultPreferences);
		}
	};
}

export const dashboardPreferences = createDashboardStore();
