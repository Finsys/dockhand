<svelte:head>
	<title>Dashboard - Dockhand</title>
</svelte:head>

<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$app/environment';
	import { RefreshCw, LayoutGrid, Loader2, Server, Tags, Square, RectangleVertical, Rows3, LayoutTemplate, Maximize2, Plus } from 'lucide-svelte';
	import { toast } from 'svelte-sonner';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import EnvironmentTile from './dashboard/EnvironmentTile.svelte';
	import EnvironmentTileSkeleton from './dashboard/EnvironmentTileSkeleton.svelte';
	import DraggableGrid, { type GridItemLayout } from './dashboard/DraggableGrid.svelte';
	import { dashboardPreferences, dashboardData, GRID_COLS, GRID_ROW_HEIGHT, type TileItem } from '$lib/stores/dashboard';
	import { currentEnvironment, environments } from '$lib/stores/environment';
	import { IsMobile } from '$lib/hooks/is-mobile.svelte';
	import type { EnvironmentStats } from './api/dashboard/stats/+server';
	import { getLabelColor, getLabelBgColor } from '$lib/utils/label-colors';

	const LABEL_FILTER_STORAGE_KEY = 'dockhand-dashboard-label-filter';

	// Real-time event stream for immediate updates
	let eventSource: EventSource | null = null;
	let eventReconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let eventReconnectAttempts = 0;
	const MAX_EVENT_RECONNECT_ATTEMPTS = 10;
	const BASE_EVENT_RECONNECT_DELAY = 5000;

	interface EnvironmentInfo {
		id: number;
		name: string;
		host?: string;
		port?: number | null;
		icon: string;
		socketPath?: string;
		collectActivity: boolean;
		collectMetrics: boolean;
		connectionType?: 'socket' | 'direct' | 'hawser-standard' | 'hawser-edge';
		labels?: string[];
	}

	// Use store data with local reactive state for UI updates
	let tiles = $state<TileItem[]>([]);
	let gridItems = $state<GridItemLayout[]>([]);
	let initialLoading = $state(true);
	let environmentsLoaded = $state(false); // Tracks if environments were ever received (prevents false "no environments" message)
	let refreshing = $state(false);
	let prefsLoaded = $state(false);
	const mobileWatcher = new IsMobile();
	const isMobile = $derived.by(() => mobileWatcher.current);

	// Subscribe to environments store's loaded flag for quick "loaded" detection
	// When loaded, immediately create skeleton tiles so the UI shows something useful
	// The SSE stream will then update these tiles with real stats
	$effect(() => {
		const unsubscribe = environments.loaded.subscribe(loaded => {
			if (loaded) {
				environmentsLoaded = true;

				// Create skeleton tiles immediately from the fast environments store
				// This avoids waiting for the slower SSE stream to show initial UI
				const envList = $environments;
				if (tiles.length === 0 && envList.length > 0) {
					const skeletonTiles = envList.map(env => ({
						id: env.id,
						stats: {
							id: env.id,
							name: env.name,
							host: env.host,
							port: env.port,
							icon: env.icon || 'globe',
							socketPath: env.socketPath,
							collectActivity: false,
							collectMetrics: true,
							connectionType: env.connectionType || 'socket',
							labels: [],
							scannerEnabled: false,
							online: undefined,
							containers: { total: 0, running: 0, stopped: 0, paused: 0, restarting: 0, unhealthy: 0, pendingUpdates: 0 },
							images: { total: 0, totalSize: 0 },
							volumes: { total: 0, totalSize: 0 },
							containersSize: 0,
							buildCacheSize: 0,
							networks: { total: 0 },
							stacks: { total: 0, running: 0, partial: 0, stopped: 0 },
							metrics: null,
							events: { total: 0, today: 0 },
							topContainers: [],
							loading: { containers: true, images: true, volumes: true, networks: true, stacks: true, diskUsage: true, topContainers: true }
						} as EnvironmentStats,
						info: { id: env.id, name: env.name, host: env.host, port: env.port, icon: env.icon || 'globe', socketPath: env.socketPath, collectActivity: false, collectMetrics: true, connectionType: env.connectionType || 'socket' },
						loading: true
					}));
					tiles = skeletonTiles;

					// Generate grid layout for these tiles
					const savedLayout = $dashboardPreferences.gridLayout;
					const tileIds = envList.map(env => env.id);
					const newGridItems = savedLayout.length > 0
						? mergeLayout(tileIds, savedLayout)
						: generateDefaultLayout(tileIds);
					gridItems = newGridItems;
				}
			}
		});
		return unsubscribe;
	});

	// Label filtering - load from localStorage
	let filterLabels = $state<string[]>([]);
	let labelFilterLoaded = $state(false);

	// Load saved label filter from localStorage
	function loadLabelFilter() {
		if (browser) {
			try {
				const saved = localStorage.getItem(LABEL_FILTER_STORAGE_KEY);
				if (saved) {
					filterLabels = JSON.parse(saved);
				}
			} catch {
				// Ignore parse errors
			}
			labelFilterLoaded = true;
		}
	}

	// Save label filter to localStorage when it changes
	$effect(() => {
		if (browser && labelFilterLoaded) {
			localStorage.setItem(LABEL_FILTER_STORAGE_KEY, JSON.stringify(filterLabels));
		}
	});

	// Toggle a label in the filter
	function toggleLabel(label: string) {
		if (filterLabels.includes(label)) {
			filterLabels = filterLabels.filter(l => l !== label);
		} else {
			filterLabels = [...filterLabels, label];
		}
	}

	// Compute all unique labels from all tiles
	const allLabels = $derived.by(() => {
		const labelSet = new Set<string>();
		for (const tile of tiles) {
			const labels = tile.stats?.labels || [];
			for (const label of labels) {
				labelSet.add(label);
			}
		}
		return Array.from(labelSet).sort();
	});

	// Validate filterLabels - remove any that don't exist in allLabels
	$effect(() => {
		if (labelFilterLoaded && filterLabels.length > 0 && tiles.length > 0) {
			const validLabels = filterLabels.filter(l => allLabels.includes(l));
			if (validLabels.length !== filterLabels.length) {
				filterLabels = validLabels;
			}
		}
	});

	// Filter grid items based on selected labels
	const filteredGridItems = $derived.by(() => {
		if (filterLabels.length === 0) {
			return gridItems;
		}
		// Filter to only show tiles whose environments have at least one matching label
		return gridItems.filter(item => {
			const tile = tiles.find(t => t.id === item.id);
			const tileLabels = tile?.stats?.labels || [];
			return tileLabels.some(label => filterLabels.includes(label));
		});
	});
	const orderedGridItems = $derived.by(() => {
		return [...filteredGridItems].sort((a, b) => (a.y - b.y) || (a.x - b.x));
	});

	// AbortController for SSE stream cleanup
	let abortController: AbortController | null = null;

	// Stream connection status
	let streamConnected = $state(false);
	let streamConnecting = $state(false);
	let streamError = $state<string | null>(null);

	// Stats stream reconnection
	const STREAM_CONNECT_TIMEOUT = 30000; // 30 seconds
	const MAX_STREAM_RECONNECT_ATTEMPTS = 5;
	const INITIAL_STREAM_RECONNECT_DELAY = 3000;
	let streamReconnectAttempts = 0;
	let streamReconnectTimer: ReturnType<typeof setTimeout> | null = null;

	// Track previous initialized state to detect changes
	let wasInitialized = true;

	// Subscribe to dashboard data store for cached data
	const unsubscribeDashboardData = dashboardData.subscribe(data => {
		if (data.tiles.length > 0) {
			tiles = data.tiles;
		}
		if (data.gridItems.length > 0) {
			gridItems = data.gridItems;
		}
		// If cache was just invalidated (transition from true to false), trigger a refresh
		if (wasInitialized && !data.initialized && data.tiles.length > 0 && !refreshing) {
			fetchStatsStreaming(true);
		}
		wasInitialized = data.initialized;
	});

	// Subscribe to preferences store to load saved layout
	const unsubscribePrefs = dashboardPreferences.subscribe(prefs => {
		if (prefs.gridLayout.length > 0 && tiles.length > 0 && !prefsLoaded) {
			// Apply saved layout
			gridItems = prefs.gridLayout.map(item => ({
				...item,
				id: item.id
			}));
			prefsLoaded = true;
		}
	});

	// Generate default grid layout for tiles
	// Default height of 2 shows standard content (CPU/mem, resources, events)
	function generateDefaultLayout(tileIds: number[]): GridItemLayout[] {
		return tileIds.map((id, index) => ({
			id,
			x: index % GRID_COLS,
			y: Math.floor(index / GRID_COLS) * 2,
			w: 1,
			h: 2
		}));
	}

	// Merge new tiles with existing layout
	function mergeLayout(tileIds: number[], existingLayout: GridItemLayout[]): GridItemLayout[] {
		const result: GridItemLayout[] = [];

		// Keep existing items in their positions
		for (const item of existingLayout) {
			if (tileIds.includes(item.id)) {
				result.push(item);
			}
		}

		// Add new tiles that don't have positions
		const existingIds = new Set(existingLayout.map(item => item.id));
		const newIds = tileIds.filter(id => !existingIds.has(id));

		// Find next available position for new items
		let nextY = result.length > 0 ? Math.max(...result.map(item => item.y + item.h)) : 0;
		let nextX = 0;

		for (const id of newIds) {
			if (nextX >= GRID_COLS) {
				nextX = 0;
				nextY += 2;
			}
			result.push({
				id,
				x: nextX,
				y: nextY,
				w: 1,
				h: 2
			});
			nextX++;
		}

		return result;
	}

	// Schedule stream reconnection with exponential backoff
	function scheduleStreamReconnect() {
		if (streamReconnectTimer) {
			clearTimeout(streamReconnectTimer);
		}

		if (streamReconnectAttempts >= MAX_STREAM_RECONNECT_ATTEMPTS) {
			streamError = 'Connection failed - click refresh to retry';
			return;
		}

		const delay = INITIAL_STREAM_RECONNECT_DELAY * Math.pow(2, streamReconnectAttempts);
		streamReconnectAttempts++;

		streamReconnectTimer = setTimeout(() => {
			fetchStatsStreaming(true);
		}, delay);
	}

	// Reset stream reconnection state
	function resetStreamReconnect() {
		streamReconnectAttempts = 0;
		if (streamReconnectTimer) {
			clearTimeout(streamReconnectTimer);
			streamReconnectTimer = null;
		}
	}

	async function fetchStatsStreaming(isRefresh = false) {
		// Abort any previous streaming request
		if (abortController) {
			abortController.abort();
		}
		abortController = new AbortController();

		// Set up connection timeout
		const timeoutController = new AbortController();
		const timeoutId = setTimeout(() => {
			timeoutController.abort();
		}, STREAM_CONNECT_TIMEOUT);

		// Update connection status
		streamConnecting = true;
		streamError = null;

		if (isRefresh) {
			refreshing = true;
			// Mark all existing tiles as refreshing but keep their data
			tiles = tiles.map(t => ({ ...t, loading: true }));
			dashboardData.markAllLoading();
		} else {
			// Only show initial loading if we have no cached data
			const cachedData = dashboardData.getData();
			if (cachedData.tiles.length === 0) {
				initialLoading = true;
				tiles = [];
			} else {
				// We have cached data - do a background refresh
				refreshing = true;
				dashboardData.markAllLoading();
			}
		}

		try {
			const response = await fetch('/api/dashboard/stats/stream', {
				signal: timeoutController.signal
			});

			clearTimeout(timeoutId);

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}

			// Connection established
			streamConnected = true;
			streamConnecting = false;
			resetStreamReconnect();

			const reader = response.body?.getReader();
			if (!reader) return;

			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				let eventType = '';
				let eventData = '';

				for (const line of lines) {
					if (line.startsWith('event: ')) {
						eventType = line.slice(7);
					} else if (line.startsWith('data: ')) {
						eventData = line.slice(6);

						if (eventType && eventData) {
							try {
								const data = JSON.parse(eventData);

								if (eventType === 'environments') {
									// Mark that we've received environment data (prevents false "no environments" message)
									environmentsLoaded = true;
									// Create tiles for each environment with initial loading state
									const envList = data as (EnvironmentInfo & { loading?: EnvironmentStats['loading'] })[];
									const cachedData = dashboardData.getData();

									// Only reset tiles if we had no cached data
									if (cachedData.tiles.length === 0) {
										const newTiles = envList.map(env => ({
											id: env.id,
											stats: {
												id: env.id,
												name: env.name,
												host: env.host,
												port: env.port,
												icon: env.icon,
												socketPath: env.socketPath,
												collectActivity: env.collectActivity ?? false,
												collectMetrics: env.collectMetrics ?? true,
												connectionType: env.connectionType || 'socket',
												labels: env.labels || [],
												scannerEnabled: false,
												online: undefined, // undefined = connecting, false = offline, true = online
												containers: { total: 0, running: 0, stopped: 0, paused: 0, restarting: 0, unhealthy: 0, pendingUpdates: 0 },
												images: { total: 0, totalSize: 0 },
												volumes: { total: 0, totalSize: 0 },
												containersSize: 0,
												buildCacheSize: 0,
												networks: { total: 0 },
												stacks: { total: 0, running: 0, partial: 0, stopped: 0 },
												metrics: null,
												events: { total: 0, today: 0 },
												topContainers: [],
												loading: env.loading
											} as EnvironmentStats,
											info: env,
											loading: true
										}));
										tiles = newTiles;
										dashboardData.setTiles(newTiles);

										// Generate or merge grid layout
										const tileIds = envList.map(env => env.id);
										const savedLayout = $dashboardPreferences.gridLayout;
										const newGridItems = savedLayout.length > 0
											? mergeLayout(tileIds, savedLayout)
											: generateDefaultLayout(tileIds);
										gridItems = newGridItems;
										dashboardData.setGridItems(newGridItems);
									} else {
										// Set loading states on existing tiles for refresh
										// Also update collectActivity, collectMetrics, connectionType, labels, and port from fresh data
										tiles = tiles.map(t => {
											const envInfo = envList.find(e => e.id === t.id);
											if (envInfo && t.stats) {
												return {
													...t,
													stats: {
														...t.stats,
														port: envInfo.port,
														collectActivity: envInfo.collectActivity ?? false,
														collectMetrics: envInfo.collectMetrics ?? true,
														connectionType: envInfo.connectionType || 'socket',
														labels: envInfo.labels || [],
														loading: envInfo.loading
													},
													info: envInfo,
													loading: true
												};
											}
											return t;
										});
									}
								} else if (eventType === 'partial') {
									// Progressive update - merge partial data into existing stats
									// Use deep merge for nested objects to preserve existing values
									const partialStats = data as Partial<EnvironmentStats> & { id: number };
									const tile = tiles.find(t => t.id === partialStats.id);
									if (tile?.stats) {
										// Use direct mutation for Svelte 5 reactivity
										// Deep merge for nested objects like containers, images, etc.
										for (const [key, value] of Object.entries(partialStats)) {
											if (value !== undefined && key !== 'id') {
												const existing = (tile.stats as any)[key];
												// Deep merge for plain objects (not arrays or null)
												if (existing && typeof existing === 'object' && !Array.isArray(existing) &&
												    value && typeof value === 'object' && !Array.isArray(value)) {
													Object.assign(existing, value);
												} else {
													(tile.stats as any)[key] = value;
												}
											}
										}
									}
									// Also update the store with deep merge
									const definedStats: Partial<EnvironmentStats> = {};
									for (const [key, value] of Object.entries(partialStats)) {
										if (value !== undefined) {
											(definedStats as any)[key] = value;
										}
									}
									dashboardData.updateTilePartial(partialStats.id, definedStats);
								} else if (eventType === 'stats') {
									// Update the tile with actual stats (legacy/fallback)
									const stats = data as EnvironmentStats;
									tiles = tiles.map(t =>
										t.id === stats.id
											? { ...t, stats, loading: false }
											: t
									);
									dashboardData.updateTile(stats.id, { stats, loading: false });
								} else if (eventType === 'complete') {
									// Environment fully loaded - clear loading states
									const { id } = data;
									const tile = tiles.find(t => t.id === id);
									if (tile?.stats) {
										// Use direct mutation for Svelte 5 reactivity
										tile.stats.loading = undefined;
										tile.loading = false;
									}
									dashboardData.updateTile(id, { loading: false });
								} else if (eventType === 'error') {
									// Per-environment error
									const { id, error } = data;

									// Update tile to show offline state
									tiles = tiles.map(t => {
										if (t.id === id && t.stats) {
											return {
												...t,
												stats: { ...t.stats, online: false, error, loading: undefined },
												loading: false
											};
										}
										return t;
									});
									dashboardData.updateTile(id, { loading: false });
								} else if (eventType === 'done') {
									initialLoading = false;
									refreshing = false;
									dashboardData.setInitialized(true);
								}
							} catch (e) {
								console.error('Failed to parse SSE data:', e);
							}
						}
						eventType = '';
						eventData = '';
					}
				}
			}

			// Stream ended normally - keep connected status since we have data
			// (dashboard stream is one-shot, not persistent like EventSource)
		} catch (error) {
			clearTimeout(timeoutId);
			streamConnecting = false;
			streamConnected = false;

			// Ignore abort errors from our own abortController - these are intentional
			if (error instanceof Error && error.name === 'AbortError') {
				// Check if this was a timeout (from timeoutController) vs intentional abort
				if (timeoutController.signal.aborted) {
					streamError = 'Connection timed out';
					scheduleStreamReconnect();
				}
				return;
			}

			console.error('Failed to fetch dashboard stats:', error);
			// Convert technical errors to user-friendly messages
			const rawError = error instanceof Error ? error.message : 'Connection failed';
			if (rawError.includes('typo') || rawError.includes('verbose')) {
				streamError = 'Connection failed';
			} else if (rawError.includes('FailedToOpenSocket') || rawError.includes('ECONNREFUSED')) {
				streamError = 'Docker not accessible';
			} else if (rawError.includes('ECONNRESET') || rawError.includes('closed')) {
				streamError = 'Connection lost';
			} else {
				streamError = 'Connection failed';
			}
			scheduleStreamReconnect();
		} finally {
			initialLoading = false;
			refreshing = false;
		}
	}

	// Handle grid item changes (position or size)
	function handleGridChange(updatedItems: GridItemLayout[]) {
		// When filtering is active, merge updated positions back into full gridItems
		// This preserves positions of hidden tiles
		const updatedMap = new Map(updatedItems.map(item => [item.id, item]));
		gridItems = gridItems.map(item => {
			const updated = updatedMap.get(item.id);
			return updated ? { ...item, x: updated.x, y: updated.y, w: updated.w, h: updated.h } : item;
		});
		dashboardData.setGridItems(gridItems);
		// Save the new layout (convert to store format)
		dashboardPreferences.setGridLayout(gridItems.map(item => ({
			id: item.id,
			x: item.x,
			y: item.y,
			w: item.w,
			h: item.h
		})));
	}

	// Get tile by id
	function getTileById(id: number): TileItem | undefined {
		return tiles.find(t => t.id === id);
	}

	// Handle tile click - select environment and navigate to containers
	function handleTileClick(envId: number) {
		const tile = getTileById(envId);
		if (tile?.stats) {
			currentEnvironment.set({ id: envId, name: tile.stats.name });
			goto('/containers');
		}
	}

	// Handle events section click - select environment and navigate to activity
	function handleEventsClick(envId: number) {
		const tile = getTileById(envId);
		if (tile?.stats) {
			currentEnvironment.set({ id: envId, name: tile.stats.name });
			goto(`/activity?env=${envId}`);
		}
	}

	// Apply autolayout - arrange all tiles with specified dimensions
	function applyAutoLayout(width: number, height: number) {
		const tileIds = tiles.map(t => t.id);
		const newGridItems: GridItemLayout[] = [];

		let x = 0;
		let y = 0;

		for (const id of tileIds) {
			// Check if tile fits in current row
			if (x + width > GRID_COLS) {
				x = 0;
				y += height;
			}

			newGridItems.push({
				id,
				x,
				y,
				w: width,
				h: height
			});

			x += width;
		}

		gridItems = newGridItems;
		dashboardData.setGridItems(newGridItems);
		dashboardPreferences.setGridLayout(newGridItems.map(item => ({
			id: item.id,
			x: item.x,
			y: item.y,
			w: item.w,
			h: item.h
		})));

		// Remove focus from trigger button
		if (document.activeElement instanceof HTMLElement) {
			document.activeElement.blur();
		}
	}

	// Actions that affect container counts and should trigger a refresh
	const CONTAINER_STATE_ACTIONS = ['start', 'stop', 'die', 'kill', 'restart', 'pause', 'unpause', 'create', 'destroy'];

	// Debounce refresh per environment to avoid hammering the API
	const pendingRefreshes: Map<number, ReturnType<typeof setTimeout>> = new Map();

	// Handle real-time container events for immediate dashboard updates
	function handleRealtimeEvent(event: any) {
		const envId = event.environmentId;
		if (!envId) return;

		// Update the tile's event counts and recent events list immediately
		tiles = tiles.map(t => {
			if (t.id === envId && t.stats) {
				const newEvent = {
					container_name: event.containerName || 'unknown',
					action: event.action,
					timestamp: event.timestamp
				};

				// Add to recent events (keep max 10, newest first)
				const updatedRecentEvents = [newEvent, ...(t.stats.recentEvents || [])].slice(0, 10);

				// Increment event counts
				const isToday = new Date(event.timestamp).toDateString() === new Date().toDateString();

				return {
					...t,
					stats: {
						...t.stats,
						events: {
							total: (t.stats.events?.total || 0) + 1,
							today: (t.stats.events?.today || 0) + (isToday ? 1 : 0)
						},
						recentEvents: updatedRecentEvents
					}
				};
			}
			return t;
		});

		// Also update the store
		const tile = tiles.find(t => t.id === envId);
		if (tile?.stats) {
			dashboardData.updateTilePartial(envId, {
				events: tile.stats.events,
				recentEvents: tile.stats.recentEvents
			});
		}

		// If this is a container state change, trigger a debounced refresh for the full tile
		if (CONTAINER_STATE_ACTIONS.includes(event.action)) {
			// Cancel any pending refresh for this environment
			const pending = pendingRefreshes.get(envId);
			if (pending) {
				clearTimeout(pending);
			}

			// Schedule a refresh after 500ms to batch rapid events
			pendingRefreshes.set(envId, setTimeout(() => {
				pendingRefreshes.delete(envId);
				refreshEnvironmentTile(envId);
			}, 500));
		}
	}

	// Refresh a single environment tile
	async function refreshEnvironmentTile(envId: number) {
		try {
			const response = await fetch(`/api/dashboard/stats?env=${envId}`);
			if (!response.ok) return;

			const stats = await response.json() as EnvironmentStats;

			tiles = tiles.map(t =>
				t.id === envId
					? { ...t, stats, loading: false }
					: t
			);
			dashboardData.updateTile(envId, { stats, loading: false });
		} catch {
			// Ignore errors - next full refresh will catch up
		}
	}

	// Connect to real-time event stream
	function connectEventStream() {
		if (eventSource) {
			eventSource.close();
		}
		if (eventReconnectTimer) {
			clearTimeout(eventReconnectTimer);
			eventReconnectTimer = null;
		}

		eventSource = new EventSource('/api/activity/events');

		eventSource.addEventListener('open', () => {
			// Show reconnection success toast if we were reconnecting
			if (eventReconnectAttempts > 0) {
				toast.success('Live updates reconnected');
			}
			eventReconnectAttempts = 0; // Reset backoff on successful connection
		});

		eventSource.addEventListener('activity', (e) => {
			try {
				const event = JSON.parse(e.data);
				handleRealtimeEvent(event);
			} catch {
				// Ignore parse errors
			}
		});

		// Handle environment status changes (online/offline)
		eventSource.addEventListener('env_status', (e) => {
			try {
				const status = JSON.parse(e.data);
				// Update tile online status
				tiles = tiles.map(t => {
					if (t.id === status.envId && t.stats) {
						return {
							...t,
							stats: {
								...t.stats,
								online: status.online,
								error: status.error
							}
						};
					}
					return t;
				});
				dashboardData.updateTilePartial(status.envId, {
					online: status.online,
					error: status.error
				});
			} catch {
				// Ignore parse errors
			}
		});

		eventSource.onerror = () => {
			eventSource?.close();
			eventSource = null;

			// Exponential backoff reconnection
			if (eventReconnectAttempts < MAX_EVENT_RECONNECT_ATTEMPTS) {
				// Show toast only on first disconnect
				if (eventReconnectAttempts === 0) {
					toast.warning('Live updates disconnected, reconnecting...');
				}

				const delay = Math.min(BASE_EVENT_RECONNECT_DELAY * Math.pow(2, eventReconnectAttempts), 60000);
				eventReconnectAttempts++;
				eventReconnectTimer = setTimeout(connectEventStream, delay);
			} else {
				toast.error('Live updates failed - refresh page to retry');
			}
		};
	}

	let refreshInterval: ReturnType<typeof setInterval>;

	// Handle tab visibility changes (e.g., user switches back from another tab)
	function handleVisibilityChange() {
		if (document.visibilityState === 'visible') {
			// Tab became visible - check and restore connections

			// Clear any pending reconnection timers
			if (eventReconnectTimer) {
				clearTimeout(eventReconnectTimer);
				eventReconnectTimer = null;
			}
			if (streamReconnectTimer) {
				clearTimeout(streamReconnectTimer);
				streamReconnectTimer = null;
			}

			// Reset reconnection counters to give fresh attempts
			eventReconnectAttempts = 0;
			streamReconnectAttempts = 0;
			streamError = null;

			// Reconnect event stream if it's closed or in error state
			if (!eventSource || eventSource.readyState !== EventSource.OPEN) {
				connectEventStream();
			}

			// Trigger a stats refresh if we haven't refreshed recently
			// (the 30s interval may have been paused while backgrounded)
			if (!refreshing && !streamConnecting) {
				fetchStatsStreaming(true);
			}
		}
	}

	onMount(async () => {
		// Listen for tab visibility changes to reconnect when user returns
		document.addEventListener('visibilitychange', handleVisibilityChange);
		// Chrome 77+ Page Lifecycle API - fires when frozen tab is resumed
		document.addEventListener('resume', handleVisibilityChange);

		// Load label filter from localStorage
		loadLabelFilter();

		// Load preferences first
		await dashboardPreferences.load();

		// Check if we have valid cached data (not invalidated)
		const cachedData = dashboardData.getData();
		if (cachedData.tiles.length > 0 && cachedData.initialized) {
			// Use cached data immediately
			tiles = cachedData.tiles;
			gridItems = cachedData.gridItems;
			initialLoading = false;
			environmentsLoaded = true;

			// Then refresh in background
			fetchStatsStreaming(true);
		} else {
			// No cache or cache invalidated - do initial fetch
			await fetchStatsStreaming();
		}

		// Connect to real-time event stream for immediate updates
		connectEventStream();

		// Refresh stats every 30 seconds
		refreshInterval = setInterval(() => fetchStatsStreaming(true), 30000);
	});

	onDestroy(() => {
		// Remove visibility change listeners
		document.removeEventListener('visibilitychange', handleVisibilityChange);
		document.removeEventListener('resume', handleVisibilityChange);

		// Abort any pending SSE stream
		if (abortController) {
			abortController.abort();
		}
		// Clear stream reconnection timer
		if (streamReconnectTimer) {
			clearTimeout(streamReconnectTimer);
			streamReconnectTimer = null;
		}
		// Close real-time event stream and clear reconnect timer
		if (eventReconnectTimer) {
			clearTimeout(eventReconnectTimer);
			eventReconnectTimer = null;
		}
		if (eventSource) {
			eventSource.close();
			eventSource = null;
		}
		// Clear any pending tile refreshes
		for (const timeout of pendingRefreshes.values()) {
			clearTimeout(timeout);
		}
		pendingRefreshes.clear();
		if (refreshInterval) {
			clearInterval(refreshInterval);
		}
		unsubscribeDashboardData();
		unsubscribePrefs();
	});
</script>

<div class="flex flex-col gap-4 h-full overflow-auto pb-4">
	<!-- Header -->
	<div class="shrink-0 flex flex-wrap justify-between items-center gap-3 min-h-8">
		<div class="flex items-center gap-4">
			<PageHeader icon={LayoutGrid} title="Environments" />

			<!-- Label filter toggles (only show if there are labels) -->
			{#if allLabels.length > 0}
				<div class="flex items-center gap-1.5">
					<button
						type="button"
						class="px-2.5 py-1 text-xs font-medium rounded transition-colors {filterLabels.length === 0
							? 'bg-primary text-primary-foreground'
							: 'bg-muted text-muted-foreground hover:bg-muted/80'}"
						onclick={() => filterLabels = []}
					>
						All
					</button>
					{#each allLabels as label}
						{@const isSelected = filterLabels.includes(label)}
						<button
							type="button"
							class="px-2.5 py-1 text-xs font-medium rounded transition-colors border"
							style={isSelected
								? `background-color: ${getLabelBgColor(label)}; border-color: ${getLabelColor(label)}; color: ${getLabelColor(label)};`
								: `background-color: transparent; border-color: hsl(var(--border)); color: hsl(var(--muted-foreground));`}
							onclick={() => toggleLabel(label)}
						>
							{label}
						</button>
					{/each}
				</div>
			{/if}
		</div>

		<div class="flex items-center gap-1">
			<!-- Add environment button -->
			<button
				onclick={() => goto('/settings?tab=environments&new=true')}
				class="p-1.5 rounded hover:bg-muted transition-colors"
				title="Add environment"
			>
				<Plus class="w-4 h-4" />
			</button>

			<!-- Autolayout dropdown -->
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<button
							{...props}
							class="p-1.5 rounded hover:bg-muted transition-colors"
							title="Auto-layout tiles"
						>
							<LayoutTemplate class="w-4 h-4" />
						</button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end" class="w-36">
					<DropdownMenu.Item onclick={() => applyAutoLayout(1, 1)} class="flex items-center gap-2 cursor-pointer">
						<Square class="w-4 h-4" />
						<span>Compact</span>
					</DropdownMenu.Item>
					<DropdownMenu.Item onclick={() => applyAutoLayout(1, 2)} class="flex items-center gap-2 cursor-pointer">
						<RectangleVertical class="w-4 h-4" />
						<span>Standard</span>
					</DropdownMenu.Item>
					<DropdownMenu.Item onclick={() => applyAutoLayout(1, 4)} class="flex items-center gap-2 cursor-pointer">
						<Rows3 class="w-4 h-4" />
						<span>Detailed</span>
					</DropdownMenu.Item>
					<DropdownMenu.Item onclick={() => applyAutoLayout(2, 4)} class="flex items-center gap-2 cursor-pointer">
						<Maximize2 class="w-4 h-4" />
						<span>Full</span>
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>

			<!-- Refresh button -->
			<button
				onclick={() => fetchStatsStreaming(true)}
				class="p-1.5 rounded hover:bg-muted transition-colors"
				title="Refresh"
				disabled={refreshing}
			>
				<RefreshCw class="w-4 h-4 {refreshing ? 'animate-spin' : ''}" />
			</button>
		</div>
	</div>

	<!-- Initial loading state before any tiles - show until we know whether environments exist -->
	{#if !environmentsLoaded && tiles.length === 0}
		<div class="flex items-center justify-center gap-2 text-muted-foreground py-8">
			<Loader2 class="w-5 h-5 animate-spin text-primary" />
			<span class="text-sm">Loading environments...</span>
		</div>
	{:else if tiles.length === 0 && environmentsLoaded && $environments.length === 0}
		<!-- No environments - only shown after we've confirmed there are none -->
		<div class="flex flex-col items-center justify-center h-64 text-muted-foreground">
			<div class="w-16 h-16 mb-4 rounded-2xl border-2 border-dashed border-muted-foreground/30 flex items-center justify-center">
				<Server class="w-8 h-8 opacity-40" />
			</div>
			<p class="text-lg font-medium text-foreground/70">No environments configured</p>
			<p class="text-sm text-muted-foreground mb-4">Add an environment to start managing your Docker hosts</p>
			<Button variant="outline" size="sm" onclick={() => goto('/settings?tab=environments')}>
				Go to Settings
			</Button>
		</div>
	{:else if filteredGridItems.length === 0}
		<!-- Filter shows no results -->
		<div class="flex flex-col items-center justify-center h-64 text-muted-foreground">
			<div class="w-16 h-16 mb-4 rounded-2xl border-2 border-dashed border-muted-foreground/30 flex items-center justify-center">
				<Tags class="w-8 h-8 opacity-40" />
			</div>
			<p class="text-lg font-medium text-foreground/70">No matching environments</p>
			<p class="text-sm text-muted-foreground mb-4">No environments match the selected label filters</p>
			<Button variant="outline" size="sm" onclick={() => filterLabels = []}>
				Clear filters
			</Button>
		</div>
	{:else}
		{#if isMobile}
			<div class="flex flex-col gap-3">
				{#each orderedGridItems as item (item.id)}
					{@const tile = getTileById(item.id)}
					{#if tile}
						{#if tile.loading && !tile.stats}
							<!-- Show skeleton while loading -->
							<div class="w-full">
								<EnvironmentTileSkeleton
									name={tile.info?.name}
									host={tile.info?.host}
									width={2}
									height={Math.max(item.h, 2)}
								/>
							</div>
						{:else if tile.stats}
							<!-- Show actual tile with data -->
							<div class="w-full cursor-pointer" onclick={() => handleTileClick(tile.stats!.id)}>
								<EnvironmentTile
									stats={tile.stats}
									width={2}
									height={Math.max(item.h, 2)}
									oneventsclick={() => handleEventsClick(tile.stats!.id)}
									showStacksBreakdown={false}
								/>
							</div>
						{/if}
					{/if}
				{/each}
			</div>
		{:else}
			<!-- Custom Draggable Grid -->
			<DraggableGrid
				items={filteredGridItems}
				cols={GRID_COLS}
				rowHeight={GRID_ROW_HEIGHT}
				gap={10}
				minW={1}
				maxW={2}
				minH={1}
				maxH={4}
				onchange={handleGridChange}
				onitemclick={handleTileClick}
			>
				{#snippet children({ item })}
					{@const tile = getTileById(item.id)}
					{#if tile}
						{#if tile.loading && !tile.stats}
							<!-- Show skeleton while loading -->
							<EnvironmentTileSkeleton
								name={tile.info?.name}
								host={tile.info?.host}
								width={item.w}
								height={item.h}
							/>
						{:else if tile.stats}
							<!-- Show actual tile with data -->
							<EnvironmentTile stats={tile.stats} width={item.w} height={item.h} oneventsclick={() => handleEventsClick(tile.stats!.id)} />
						{/if}
					{/if}
				{/snippet}
			</DraggableGrid>
		{/if}
	{/if}
</div>
