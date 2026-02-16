<svelte:head>
	<title>Logs - Dockhand</title>
</svelte:head>

<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/stores';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { ToggleGroup } from '$lib/components/ui/toggle-pill';
	import { RefreshCw, Search, ChevronDown, ChevronUp, Unplug, Copy, Download, WrapText, ArrowDownToLine, X, Sun, Moon, LayoutList, Square, Box, Wifi, WifiOff, Pause, Play, ScrollText, Star, GripVertical, Layers, Check, FolderHeart, Save, Trash2, MoreHorizontal } from 'lucide-svelte';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import PageHeader from '$lib/components/PageHeader.svelte';
import type { FavoriteGroup } from '../api/preferences/favorite-groups/+server';
	import type { ContainerInfo } from '$lib/types';
	import { currentEnvironment, environments, appendEnvParam } from '$lib/stores/environment';
	import { appSettings } from '$lib/stores/settings';
	import { NoEnvironment } from '$lib/components/ui/empty-state';

	// Track if we've handled the initial container from URL
	let initialContainerHandled = $state(false);

	let containers = $state<ContainerInfo[]>([]);
	let selectedContainer = $state<ContainerInfo | null>(null);
	let logs = $state('');
	let loading = $state(false);
	let autoScroll = $state(true);
	let fontSize = $state(12);
	let wordWrap = $state(true);
	let darkMode = $state(true);
	let layoutMode = $state<'single' | 'multi' | 'grouped'>('multi');
	let streamingEnabled = $state(true);
	let initialStateLoaded = $state(false);
	let isConnected = $state(false);
	let connectionError = $state<string | null>(null);
	let eventSource: EventSource | null = null;
	let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
	let reconnectAttempts = $state(0);
	const MAX_RECONNECT_ATTEMPTS = 5;
	const RECONNECT_DELAY = 3000;

	// Grouped mode state
	let selectedContainerIds = $state<Set<string>>(new Set());
	let groupedContainerInfo = $state<Map<string, { name: string; color: string }>>(new Map());
	let mergedLogs = $state<Array<{ containerId: string; containerName: string; color: string; text: string; timestamp?: string; stream?: string }>>([]);
	let stackName = $state<string | null>(null);

	// Batching for log updates to prevent UI blocking
	let pendingLogs: Array<{ containerId: string; containerName: string; color: string; text: string; timestamp?: string; stream?: string }> = [];
	let batchTimeout: ReturnType<typeof setTimeout> | null = null;
	const BATCH_INTERVAL = 50; // ms - batch logs for 50ms before updating state

	// Flush pending logs to state (called on timer)
	function flushPendingLogs() {
		if (pendingLogs.length === 0) return;

		// Batch all pending logs into a single state update
		let newLogs = [...mergedLogs, ...pendingLogs];
		pendingLogs = [];

		// Keep only last 5000 lines to prevent memory issues
		if (newLogs.length > 5000) {
			newLogs = newLogs.slice(-4000);
		}

		mergedLogs = newLogs;
		batchTimeout = null;
	}

	// Multi-mode selection state (for merge feature)
	let multiModeSelections = $state<Set<string>>(new Set());

	// Favorites state
	let favorites = $state<string[]>([]);
	let favoritesLoading = $state(false);

	// Favorite groups state
	let favoriteGroups = $state<FavoriteGroup[]>([]);
	let favoriteGroupsLoading = $state(false);
	let showSaveGroupInput = $state(false);
	let newGroupName = $state('');

	// Drag and drop state for favorites reordering
	let draggedFavorite = $state<string | null>(null);
	let dragOverFavorite = $state<string | null>(null);

	/**
	 * STATE PERSISTENCE - Simple approach:
	 * - Save entire state whenever anything changes
	 * - Restore entire state on page load
	 * - Environment-specific (each env has its own saved state)
	 */
	const STORAGE_KEY_PREFIX = 'dockhand-logs-';

	interface LogsPageState {
		// Layout & UI settings
		layoutMode: 'single' | 'multi' | 'grouped';
		darkMode: boolean;
		wordWrap: boolean;
		fontSize: number;
		autoScroll: boolean;
		streamingEnabled: boolean;
		// Selection state (depends on mode)
		selectedContainerId: string | null;      // for single/multi mode
		selectedContainerIds: string[];          // for grouped mode
		stackName: string | null;                // group name (from stacks or saved groups)
	}

	function getStorageKey(envId: number | null): string {
		return `${STORAGE_KEY_PREFIX}${envId ?? 'default'}`;
	}

	function loadState(envId: number | null): Partial<LogsPageState> {
		if (typeof window === 'undefined') return {};
		try {
			const saved = localStorage.getItem(getStorageKey(envId));
			return saved ? JSON.parse(saved) : {};
		} catch {
			return {};
		}
	}

	function saveState() {
		if (typeof window === 'undefined') return;
		const state: LogsPageState = {
			layoutMode,
			darkMode,
			wordWrap,
			fontSize,
			autoScroll,
			streamingEnabled,
			selectedContainerId: selectedContainer?.id ?? null,
			selectedContainerIds: Array.from(selectedContainerIds),
			stackName
		};
		localStorage.setItem(getStorageKey(envId), JSON.stringify(state));
	}

	// Layout mode options for ToggleGroup
	const layoutModeOptions = [
		{ value: 'single', label: 'Single', icon: Square },
		{ value: 'multi', label: 'Multi', icon: LayoutList },
		{ value: 'grouped', label: 'Grouped', icon: Layers }
	];

	// Svelte action to focus element on mount
	function focusOnMount(node: HTMLInputElement) {
		node.focus();
	}

	// Handle layout mode change
	function handleLayoutModeChange(newMode: string) {
		const mode = newMode as 'single' | 'multi' | 'grouped';
		// Note: layoutMode is already updated via bind:value before this callback runs

		if (mode === 'grouped') {
			// Switching TO grouped mode
			// If we have a single container streaming, use it as the grouped selection
			if (selectedContainer) {
				stopStreaming();
				selectedContainerIds = new Set([selectedContainer.id]);
				stackName = null;
				if (streamingEnabled) {
					startGroupedStreaming();
				}
				// Save state since we're carrying over the selection to this mode
				saveState();
			} else {
				// No single container - restore selection from saved state
				const saved = loadState(envId);
				if (saved.selectedContainerIds?.length) {
					selectedContainerIds = new Set(
						saved.selectedContainerIds
							.map(id => containers.find(c => c.id === id || c.name === id)?.id)
							.filter((id): id is string => !!id)
					);
					stackName = saved.stackName ?? null;
					if (selectedContainerIds.size > 0 && streamingEnabled) {
						startGroupedStreaming();
					}
				}
			}
		} else if (mode === 'multi') {
			// Switching to multi mode - keep single container selected and streaming
			// selectedContainer stays as is, streaming continues
			// Just clear grouped mode data
			selectedContainerIds = new Set();
			mergedLogs = [];
			// Save state if we have a container selected (carrying over selection)
			if (selectedContainer) {
				saveState();
			}
		} else {
			// Switching to single mode
			// If we have exactly one grouped container, use it as the single container
			if (selectedContainerIds.size === 1) {
				const containerId = Array.from(selectedContainerIds)[0];
				const container = containers.find(c => c.id === containerId);
				if (container) {
					// Stop grouped streaming and start single streaming
					stopStreaming();
					selectedContainerIds = new Set();
					mergedLogs = [];
					selectedContainer = container;
					if (streamingEnabled) {
						startStreaming(container);
					}
					saveState();
				}
			} else if (selectedContainerIds.size > 1) {
				// Multiple containers - just stop streaming
				stopStreaming();
				selectedContainerIds = new Set();
				mergedLogs = [];
			}
			// If selectedContainer already exists (from multi mode), keep it streaming
			// Save state if we have a container selected (carrying over selection)
			if (selectedContainer && selectedContainerIds.size === 0) {
				saveState();
			}
		}
	}

	// Toggle theme
	function toggleTheme() {
		darkMode = !darkMode;
		saveState();
	}
	let logsRef: HTMLDivElement | undefined;
	let envId = $state<number | null>(null);
	let isInitialLoad = $state(true);

	// Polling interval - module scope for cleanup in onDestroy
	let containerInterval: ReturnType<typeof setInterval> | null = null;

	// Searchable dropdown state
	let searchQuery = $state('');
	let dropdownOpen = $state(false);

	// Log search state
	let logSearchActive = $state(false);
	let logSearchQuery = $state('');
	let currentMatchIndex = $state(0);
	let matchCount = $state(0);
	let logSearchInputRef: HTMLInputElement | undefined;

	const fontSizeOptions = [10, 12, 14, 16];

	// Subscribe to environment changes - restore state and fetch data
	currentEnvironment.subscribe(async (env) => {
		envId = env?.id ?? null;
		if (!env) return;

		// Immediately restore UI-only settings to prevent flash (before async fetches)
		const savedUiState = loadState(envId);
		if (savedUiState.layoutMode !== undefined) layoutMode = savedUiState.layoutMode;
		if (savedUiState.darkMode !== undefined) darkMode = savedUiState.darkMode;
		if (savedUiState.wordWrap !== undefined) wordWrap = savedUiState.wordWrap;
		if (savedUiState.fontSize !== undefined) fontSize = savedUiState.fontSize;
		if (savedUiState.autoScroll !== undefined) autoScroll = savedUiState.autoScroll;
		if (savedUiState.streamingEnabled !== undefined) streamingEnabled = savedUiState.streamingEnabled;
		initialStateLoaded = true;

		// Fetch data for this environment
		const fetchedContainers = await fetchContainers();
		await fetchFavorites();
		await fetchFavoriteGroups();

		// Only handle initialization once per page load
		if (initialContainerHandled) return;
		initialContainerHandled = true;

		// Check for URL params first (from stacks page or direct links)
		const urlContainerIds = $page.url.searchParams.get('containers');
		const urlStackName = $page.url.searchParams.get('stack');
		const urlContainerId = $page.url.searchParams.get('container');

		if (urlContainerIds) {
			// Grouped containers from URL (e.g., from stacks page)
			const ids = urlContainerIds.split(',').filter(Boolean);
			const matchedIds = ids
				.map(urlId => fetchedContainers.find(c => c.id === urlId || c.id.startsWith(urlId))?.id)
				.filter((id): id is string => id !== undefined);

			// Always switch to grouped mode when URL has containers param
			layoutMode = 'grouped';
			stackName = urlStackName ?? null;

			if (matchedIds.length > 0) {
				selectedContainerIds = new Set(matchedIds);
				saveState();
				startGroupedStreaming();
			} else {
				// No running containers found - show empty state for this stack
				selectedContainerIds = new Set();
				mergedLogs = [];
				saveState();
			}
			return;
		}

		if (urlContainerId) {
			// Single container from URL - always switch to single mode
			layoutMode = 'single';
			const container = fetchedContainers.find(c => c.id === urlContainerId || c.id.startsWith(urlContainerId));
			if (container) {
				selectContainer(container);
			} else {
				// Container not running - clear selection and logs
				selectedContainer = null;
				logs = '';
			}
			return;
		}

		// No URL params - restore container-dependent state
		// (UI settings like layoutMode were already restored above before fetches)
		if (savedUiState.stackName !== undefined) stackName = savedUiState.stackName;

		// Restore container selection based on mode
		if (layoutMode === 'grouped' && savedUiState.selectedContainerIds?.length) {
			// Validate container IDs still exist
			const validIds = savedUiState.selectedContainerIds.filter(id =>
				fetchedContainers.some(c => c.id === id)
			);
			if (validIds.length > 0) {
				selectedContainerIds = new Set(validIds);
				if (streamingEnabled) {
					startGroupedStreaming();
				}
			}
		} else if ((layoutMode === 'single' || layoutMode === 'multi') && savedUiState.selectedContainerId) {
			const container = fetchedContainers.find(c => c.id === savedUiState.selectedContainerId);
			if (container) {
				selectContainer(container);
			}
		}
	});

	// Filtered containers based on search
	let filteredContainers = $derived(() => {
		if (!searchQuery.trim()) return containers;
		const query = searchQuery.toLowerCase();
		return containers.filter(c =>
			c.name.toLowerCase().includes(query) ||
			c.image.toLowerCase().includes(query)
		);
	});

	// Favorite containers (filtered and sorted by favorites order)
	let favoriteContainers = $derived(() => {
		const filtered = filteredContainers();
		// Map favorites to containers, preserving order from favorites array
		return favorites
			.map(name => filtered.find(c => c.name === name))
			.filter((c): c is ContainerInfo => c !== undefined);
	});

	// Non-favorite containers
	let nonFavoriteContainers = $derived(() => {
		return filteredContainers().filter(c => !favorites.includes(c.name));
	});

	async function fetchContainers(): Promise<ContainerInfo[]> {
		try {
			const response = await fetch(appendEnvParam('/api/containers', envId));
			const allContainers = await response.json();
			// Show running and exited containers (logs are available for both)
			const loggableContainers = allContainers.filter((c: ContainerInfo) =>
				c.state === 'running' || c.state === 'exited'
			);
			containers = loggableContainers;

			// If selected container is no longer available, clear selection
			if (selectedContainer && !containers.find((c) => c.id === selectedContainer?.id)) {
				selectedContainer = null;
				logs = '';
			}
			return loggableContainers;
		} catch (error) {
			console.error('Failed to fetch containers:', error);
			return [];
		}
	}

	// Fetch favorites for current environment
	async function fetchFavorites() {
		if (!envId) return;

		favoritesLoading = true;
		try {
			const response = await fetch(`/api/preferences/favorites?env=${envId}`);
			const data = await response.json();
			favorites = data.favorites ?? [];
		} catch (error) {
			console.error('Failed to fetch favorites:', error);
			favorites = [];
		} finally {
			favoritesLoading = false;
		}
	}

	// Fetch favorite groups for current environment
	async function fetchFavoriteGroups() {
		if (!envId) return;

		favoriteGroupsLoading = true;
		try {
			const response = await fetch(`/api/preferences/favorite-groups?env=${envId}`);
			const data = await response.json();
			favoriteGroups = data.groups ?? [];
		} catch (error) {
			console.error('Failed to fetch favorite groups:', error);
			favoriteGroups = [];
		} finally {
			favoriteGroupsLoading = false;
		}
	}

	// Save current selection as a favorite group
	async function saveCurrentGroup() {
		if (!envId || selectedContainerIds.size === 0 || !newGroupName.trim()) return;

		// Get container names from IDs
		const containerNames = Array.from(selectedContainerIds)
			.map(id => containers.find(c => c.id === id)?.name)
			.filter((name): name is string => name !== undefined);

		if (containerNames.length === 0) return;

		try {
			const response = await fetch('/api/preferences/favorite-groups', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					environmentId: envId,
					action: 'add',
					name: newGroupName.trim(),
					containers: containerNames
				})
			});

			if (response.ok) {
				const data = await response.json();
				favoriteGroups = data.groups;
				newGroupName = '';
				showSaveGroupInput = false;
			}
		} catch (error) {
			console.error('Failed to save favorite group:', error);
		}
	}

	// Delete a favorite group
	async function deleteFavoriteGroup(groupName: string) {
		if (!envId) return;

		try {
			const response = await fetch('/api/preferences/favorite-groups', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					environmentId: envId,
					action: 'remove',
					name: groupName
				})
			});

			if (response.ok) {
				const data = await response.json();
				favoriteGroups = data.groups;
			}
		} catch (error) {
			console.error('Failed to delete favorite group:', error);
		}
	}

	// Load a favorite group (select its containers)
	function loadFavoriteGroup(group: FavoriteGroup) {
		// Find container IDs from names
		const containerIds = group.containers
			.map(name => containers.find(c => c.name === name)?.id)
			.filter((id): id is string => id !== undefined);

		if (containerIds.length === 0) return;

		// Set the selection and switch to grouped mode
		selectedContainerIds = new Set(containerIds);
		layoutMode = 'grouped';
		stackName = group.name; // Show the saved group name in header
		saveState();
		startGroupedStreaming();
	}

	// Toggle favorite status for a container
	async function toggleFavorite(containerName: string, event: MouseEvent) {
		event.stopPropagation(); // Prevent container selection
		if (!envId) return;

		const isFavorite = favorites.includes(containerName);
		const action = isFavorite ? 'remove' : 'add';

		// Optimistic update
		if (isFavorite) {
			favorites = favorites.filter(name => name !== containerName);
		} else {
			favorites = [...favorites, containerName];
		}

		try {
			const response = await fetch('/api/preferences/favorites', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					containerName,
					environmentId: envId,
					action
				})
			});

			if (!response.ok) {
				// Revert on error
				if (isFavorite) {
					favorites = [...favorites, containerName];
				} else {
					favorites = favorites.filter(name => name !== containerName);
				}
			} else {
				const data = await response.json();
				favorites = data.favorites;
			}
		} catch (error) {
			console.error('Failed to toggle favorite:', error);
			// Revert on error
			if (isFavorite) {
				favorites = [...favorites, containerName];
			} else {
				favorites = favorites.filter(name => name !== containerName);
			}
		}
	}

	// Check if a container is favorited
	function isFavorite(containerName: string): boolean {
		return favorites.includes(containerName);
	}

	// Drag and drop handlers for favorites reordering
	function handleDragStart(e: DragEvent, containerName: string) {
		if (!e.dataTransfer) return;
		draggedFavorite = containerName;
		e.dataTransfer.effectAllowed = 'move';
		e.dataTransfer.setData('text/plain', containerName);
	}

	function handleDragOver(e: DragEvent, containerName: string) {
		e.preventDefault();
		if (!e.dataTransfer) return;
		e.dataTransfer.dropEffect = 'move';
		dragOverFavorite = containerName;
	}

	function handleDragLeave() {
		dragOverFavorite = null;
	}

	function handleDragEnd() {
		draggedFavorite = null;
		dragOverFavorite = null;
	}

	async function handleDrop(e: DragEvent, targetName: string) {
		e.preventDefault();
		if (!draggedFavorite || draggedFavorite === targetName || !envId) {
			handleDragEnd();
			return;
		}

		// Reorder favorites array
		const newFavorites = [...favorites];
		const draggedIndex = newFavorites.indexOf(draggedFavorite);
		const targetIndex = newFavorites.indexOf(targetName);

		if (draggedIndex === -1 || targetIndex === -1) {
			handleDragEnd();
			return;
		}

		// Remove dragged item and insert at target position
		newFavorites.splice(draggedIndex, 1);
		newFavorites.splice(targetIndex, 0, draggedFavorite);

		// Optimistic update
		favorites = newFavorites;
		handleDragEnd();

		// Persist to server
		try {
			const response = await fetch('/api/preferences/favorites', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					environmentId: envId,
					action: 'reorder',
					favorites: newFavorites
				})
			});

			if (response.ok) {
				const data = await response.json();
				favorites = data.favorites;
			}
		} catch (error) {
			console.error('Failed to reorder favorites:', error);
			// Refresh from server on error
			await fetchFavorites();
		}
	}

	async function fetchLogs(tail: number = 500) {
		if (!selectedContainer) return;

		loading = true;
		try {
			const response = await fetch(appendEnvParam(`/api/containers/${selectedContainer.id}/logs?tail=${tail}`, envId));
			const data = await response.json();
			logs = data.logs || 'No logs available';
			// Scrolling is handled by the $effect that watches logs changes
		} catch (error) {
			console.error('Failed to fetch logs:', error);
			logs = 'Failed to fetch logs: ' + String(error);
		} finally {
			loading = false;
		}
	}

	// Start SSE streaming for single container logs
	function startStreaming() {
		if (!selectedContainer || !streamingEnabled) return;

		// For stopped containers, just fetch logs once - no streaming
		if (selectedContainer.state !== 'running') {
			fetchLogs(500);
			isConnected = false;
			connectionError = null;
			return;
		}

		stopStreaming(false); // Don't reset reconnect attempts

		connectionError = null;
		const containerId = selectedContainer.id; // Capture for closure

		try {
			const url = appendEnvParam(`/api/containers/${containerId}/logs/stream?tail=500`, envId);
			eventSource = new EventSource(url);

			eventSource.addEventListener('connected', () => {
				isConnected = true;
				loading = false;
				connectionError = null;
				reconnectAttempts = 0; // Reset on successful connection
			});

			eventSource.addEventListener('log', (event) => {
				try {
					const data = JSON.parse(event.data);
					if (data.text) {
						// Add container name prefix to each line if available
						let text = data.text;
						if (data.containerName) {
							// Split by lines, prefix each non-empty line, rejoin
							const lines = text.split('\n');
							text = lines.map((line: string, i: number) => {
								// Don't prefix empty lines at the end
								if (line === '' && i === lines.length - 1) return line;
								if (line === '') return line;
								return `[${data.containerName}] ${line}`;
							}).join('\n');
						}
						logs += text;

						// Apply log buffer size limit (convert KB to characters)
						const maxSize = $appSettings.logBufferSizeKb * 1024;
						if (logs.length > maxSize) {
							logs = logs.substring(logs.length - Math.floor(maxSize * 0.8));
						}
					}
				} catch {
					// Ignore parse errors
				}
			});

			eventSource.addEventListener('error', (event: Event) => {
				try {
					const data = JSON.parse((event as MessageEvent).data);
					connectionError = data.error || 'Connection error';
				} catch {
					connectionError = 'Connection error';
				}
				handleStreamError();
			});

			eventSource.addEventListener('end', () => {
				isConnected = false;
				// Container stopped or stream ended normally - don't auto-reconnect
				connectionError = 'Stream ended';
			});

			eventSource.onerror = () => {
				// EventSource error - could be network issue, server down, etc.
				handleStreamError();
			};
		} catch (error) {
			console.error('Failed to start streaming:', error);
			connectionError = 'Failed to start streaming';
			isConnected = false;
			loading = false;
		}
	}

	// Color palette for containers (same as server-side)
	const CONTAINER_COLORS = ['#60a5fa', '#4ade80', '#f472b6', '#facc15', '#a78bfa', '#fb923c', '#22d3ee', '#f87171', '#34d399', '#c084fc'];

	// Get color for a container based on its position in all selected containers
	function getContainerColor(containerId: string): string {
		const allIds = Array.from(selectedContainerIds);
		const index = allIds.indexOf(containerId);
		return CONTAINER_COLORS[index >= 0 ? index % CONTAINER_COLORS.length : 0];
	}

	// Fetch logs once for stopped containers in grouped mode
	async function fetchStoppedContainerLogs(stoppedIds: string[]) {
		for (const containerId of stoppedIds) {
			const container = containers.find(c => c.id === containerId);
			if (!container) continue;

			try {
				const response = await fetch(appendEnvParam(`/api/containers/${containerId}/logs?tail=100`, envId));
				const data = await response.json();
				const containerName = container.name;
				const color = getContainerColor(containerId);

				// Always add to container info (even if no logs)
				groupedContainerInfo = new Map([...groupedContainerInfo, [containerId, { name: containerName, color }]]);

				if (data.logs) {
					// Parse and add logs
					const lines = data.logs.split('\n').filter((line: string) => line.trim());
					for (const line of lines) {
						mergedLogs.push({
							containerId,
							containerName,
							color,
							text: line + '\n',
							timestamp: new Date().toISOString()
						});
					}
					mergedLogs = mergedLogs;
				}
			} catch (error) {
				console.error(`Failed to fetch logs for stopped container ${containerId}:`, error);
				// Still add to header even on error
				const containerName = container.name;
				const color = getContainerColor(containerId);
				groupedContainerInfo = new Map([...groupedContainerInfo, [containerId, { name: containerName, color }]]);
			}
		}
		// Mark loading done if only stopped containers
		loading = false;
	}

	// Check if any selected container is running (for reconnection logic)
	function hasRunningContainers(): boolean {
		if (layoutMode === 'grouped') {
			return Array.from(selectedContainerIds).some(id => {
				const container = containers.find(c => c.id === id);
				return container?.state === 'running';
			});
		}
		return selectedContainer?.state === 'running' ?? false;
	}

	// Start SSE streaming for grouped/merged logs
	function startGroupedStreaming() {
		if (selectedContainerIds.size === 0 || !streamingEnabled) return;
		stopStreaming(false);

		connectionError = null;
		// Always show loading spinner (as overlay if logs exist, full if no logs)
		loading = true;
		// Clear container info for fresh selection (prevents icon accumulation)
		groupedContainerInfo = new Map();
		mergedLogs = [];

		// Separate running and stopped containers
		const allIds = Array.from(selectedContainerIds);
		const runningIds = allIds.filter(id => {
			const container = containers.find(c => c.id === id);
			return container?.state === 'running';
		});
		const stoppedIds = allIds.filter(id => {
			const container = containers.find(c => c.id === id);
			return container?.state !== 'running';
		});

		// Fetch logs once for stopped containers
		if (stoppedIds.length > 0) {
			fetchStoppedContainerLogs(stoppedIds);
		}

		// If no running containers, just show the stopped logs and exit
		if (runningIds.length === 0) {
			loading = false;
			isConnected = false;
			connectionError = null;
			return;
		}

		try {
			const containerIdsParam = runningIds.join(',');
			const url = appendEnvParam(`/api/logs/merged?containers=${containerIdsParam}&tail=100`, envId);
			eventSource = new EventSource(url);

			eventSource.addEventListener('connected', (event) => {
				isConnected = true;
				loading = false;
				connectionError = null;
				reconnectAttempts = 0;

				try {
					const data = JSON.parse(event.data);
					if (data.containers) {
						// Merge with existing container info (preserves stopped containers)
						const newMap = new Map(groupedContainerInfo);
						for (const c of data.containers) {
							// Use consistent color based on position in all selected containers
							const color = getContainerColor(c.id);
							newMap.set(c.id, { name: c.name, color });
						}
						groupedContainerInfo = newMap;
					}
				} catch {
					// Ignore parse errors
				}
			});

			eventSource.addEventListener('log', (event) => {
				try {
					const data = JSON.parse(event.data);
					if (data.text) {
						// Use consistent color based on position in all selected containers
						const color = getContainerColor(data.containerId);
						// Add to pending batch instead of updating state immediately
						pendingLogs.push({
							containerId: data.containerId,
							containerName: data.containerName,
							color,
							text: data.text,
							timestamp: data.timestamp,
							stream: data.stream
						});
						// Schedule flush if not already scheduled
						if (!batchTimeout) {
							batchTimeout = setTimeout(flushPendingLogs, BATCH_INTERVAL);
						}
					}
				} catch {
					// Ignore parse errors
				}
			});

			eventSource.addEventListener('error', (event: Event) => {
				try {
					const data = JSON.parse((event as MessageEvent).data);
					connectionError = data.error || 'Connection error';
				} catch {
					connectionError = 'Connection error';
				}
				handleStreamError();
			});

			eventSource.addEventListener('end', () => {
				isConnected = false;
				connectionError = 'Stream ended';
			});

			eventSource.onerror = () => {
				handleStreamError();
			};
		} catch (error) {
			console.error('Failed to start grouped streaming:', error);
			connectionError = 'Failed to start streaming';
			isConnected = false;
			loading = false;
		}
	}

	// Handle stream errors with reconnection logic
	function handleStreamError() {
		isConnected = false;
		loading = false;

		// Close the broken connection
		if (eventSource) {
			eventSource.close();
			eventSource = null;
		}

		// Don't reconnect if streaming is disabled or no container selected
		if (!streamingEnabled || (layoutMode !== 'grouped' && !selectedContainer) || (layoutMode === 'grouped' && selectedContainerIds.size === 0)) return;

		// Don't reconnect if there are no running containers
		if (!hasRunningContainers()) {
			connectionError = null;
			return;
		}

		// Check if we should attempt reconnection
		if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
			reconnectAttempts++;
			connectionError = `Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`;

			// Clear any existing reconnect timeout
			if (reconnectTimeout) {
				clearTimeout(reconnectTimeout);
			}

			// Schedule reconnection
			reconnectTimeout = setTimeout(() => {
				if (streamingEnabled) {
					loading = true;
					if (layoutMode === 'grouped') {
						startGroupedStreaming();
					} else if (selectedContainer) {
						startStreaming();
					}
				}
			}, RECONNECT_DELAY);
		} else {
			connectionError = 'Connection failed. Click to retry.';
		}
	}

	// Manual retry connection
	function retryConnection() {
		reconnectAttempts = 0;
		connectionError = null;
		logs = '';
		mergedLogs = [];
		loading = true;
		if (layoutMode === 'grouped') {
			startGroupedStreaming();
		} else {
			startStreaming();
		}
	}

	// Stop SSE streaming
	function stopStreaming(resetAttempts = true) {
		if (reconnectTimeout) {
			clearTimeout(reconnectTimeout);
			reconnectTimeout = null;
		}
		// Clear batch timeout and pending logs
		if (batchTimeout) {
			clearTimeout(batchTimeout);
			batchTimeout = null;
		}
		pendingLogs = [];
		if (eventSource) {
			eventSource.close();
			eventSource = null;
		}
		isConnected = false;
		if (resetAttempts) {
			reconnectAttempts = 0;
			connectionError = null;
		}
	}

	// Toggle streaming on/off
	function toggleStreaming() {
		streamingEnabled = !streamingEnabled;
		saveState();
		if (streamingEnabled) {
			logs = '';
			mergedLogs = [];
			reconnectAttempts = 0;
			connectionError = null;
			loading = true;
			if (layoutMode === 'grouped') {
				startGroupedStreaming();
			} else if (selectedContainer) {
				startStreaming();
			}
		} else {
			stopStreaming();
		}
	}

	function selectContainer(container: ContainerInfo) {
		// Stop any existing stream
		stopStreaming();

		selectedContainer = container;
		searchQuery = '';
		dropdownOpen = false;
		isInitialLoad = true; // Reset so we scroll to bottom on new container
		logs = ''; // Clear previous logs

		// Save selection for persistence
		saveState();

		if (streamingEnabled) {
			loading = true;
			startStreaming();
		} else {
			fetchLogs();
		}
	}

	// Toggle container selection in grouped mode - always starts streaming immediately
	function toggleContainerSelection(containerId: string) {
		const newSet = new Set(selectedContainerIds);
		if (newSet.has(containerId)) {
			newSet.delete(containerId);
		} else {
			newSet.add(containerId);
		}
		selectedContainerIds = newSet;

		// Clear stack/group name when manually changing selection
		stackName = null;

		// Save selection to localStorage
		saveState();

		// Start streaming with new selection (or stop if empty)
		if (newSet.size > 0 && streamingEnabled) {
			startGroupedStreaming();
		} else if (newSet.size === 0) {
			stopStreaming();
			mergedLogs = [];
		}
	}

	// Start grouped streaming with current selection
	function startGroupedView() {
		if (selectedContainerIds.size === 0) return;
		mergedLogs = [];
		loading = true;
		startGroupedStreaming();
	}

	// Select all visible containers
	function selectAllContainers() {
		const allIds = new Set(filteredContainers().map(c => c.id));
		selectedContainerIds = allIds;
	}

	// Clear all container selections
	function clearContainerSelection() {
		selectedContainerIds = new Set();
		stopStreaming();
		mergedLogs = [];
	}

	// Multi-mode: toggle a container in the multi-select list
	function toggleMultiModeSelection(containerId: string, event: MouseEvent) {
		event.stopPropagation();
		const newSet = new Set(multiModeSelections);
		if (newSet.has(containerId)) {
			newSet.delete(containerId);
		} else {
			newSet.add(containerId);
		}
		multiModeSelections = newSet;
	}

	// Multi-mode: merge selected containers (switch to grouped mode)
	function mergeSelectedContainers() {
		if (multiModeSelections.size === 0) return;

		// Transfer selections to grouped mode
		selectedContainerIds = new Set(multiModeSelections);
		multiModeSelections = new Set();

		// Clear stack name since this is a new ad-hoc group, not from stacks page
		stackName = null;

		// Switch to grouped mode and start streaming
		layoutMode = 'grouped';
		saveState();
		startGroupedStreaming();
	}

	// Multi-mode: clear multi-select
	function clearMultiModeSelection() {
		multiModeSelections = new Set();
	}

	function clearSelection() {
		stopStreaming();
		selectedContainer = null;
		logs = '';
		searchQuery = '';
	}

	function handleInputFocus() {
		dropdownOpen = true;
	}

	function handleInputBlur(e: FocusEvent) {
		// Delay closing to allow click on dropdown item
		setTimeout(() => {
			dropdownOpen = false;
		}, 200);
	}

	function handleInputKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			const filtered = filteredContainers();
			if (filtered.length > 0) {
				selectContainer(filtered[0]);
			}
		}
	}


	// Copy logs to clipboard
	async function copyLogs() {
		const textToCopy = layoutMode === 'grouped'
			? mergedLogs.map(l => `[${l.containerName}] ${l.text}`).join('')
			: logs;
		if (textToCopy) {
			await copyToClipboard(textToCopy);
		}
	}

	// Download logs as txt file
	function downloadLogs() {
		const textToDownload = layoutMode === 'grouped'
			? mergedLogs.map(l => `[${l.containerName}] ${l.text}`).join('')
			: logs;
		const filename = layoutMode === 'grouped'
			? 'merged-logs.txt'
			: selectedContainer ? `${selectedContainer.name}-logs.txt` : 'logs.txt';

		if (textToDownload) {
			const blob = new Blob([textToDownload], { type: 'text/plain' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = filename;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
		}
	}

	// Log search functions
	function toggleLogSearch() {
		logSearchActive = !logSearchActive;
		if (logSearchActive) {
			setTimeout(() => logSearchInputRef?.focus(), 50);
		} else {
			logSearchQuery = '';
			currentMatchIndex = 0;
			matchCount = 0;
		}
	}

	function closeLogSearch() {
		logSearchActive = false;
		logSearchQuery = '';
		currentMatchIndex = 0;
		matchCount = 0;
	}

	function navigateMatch(direction: 'prev' | 'next') {
		if (!logsRef || matchCount === 0) return;

		const matches = logsRef.querySelectorAll('.search-match');
		if (matches.length === 0) return;

		// Remove highlight from current
		matches[currentMatchIndex]?.classList.remove('current-match');

		if (direction === 'next') {
			currentMatchIndex = (currentMatchIndex + 1) % matches.length;
		} else {
			currentMatchIndex = (currentMatchIndex - 1 + matches.length) % matches.length;
		}

		// Add highlight to new current and scroll into view
		const currentEl = matches[currentMatchIndex];
		if (currentEl) {
			currentEl.classList.add('current-match');
			currentEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
		}
	}

	function handleLogSearchKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			if (e.shiftKey) {
				navigateMatch('prev');
			} else {
				navigateMatch('next');
			}
		} else if (e.key === 'Escape') {
			closeLogSearch();
		}
	}

	// Escape HTML to prevent XSS
	function escapeHtml(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#039;');
	}

	// ANSI color code to CSS class mapping
	const ansiColorMap: Record<string, string> = {
		'30': 'ansi-black',
		'31': 'ansi-red',
		'32': 'ansi-green',
		'33': 'ansi-yellow',
		'34': 'ansi-blue',
		'35': 'ansi-magenta',
		'36': 'ansi-cyan',
		'37': 'ansi-white',
		'90': 'ansi-bright-black',
		'91': 'ansi-bright-red',
		'92': 'ansi-bright-green',
		'93': 'ansi-bright-yellow',
		'94': 'ansi-bright-blue',
		'95': 'ansi-bright-magenta',
		'96': 'ansi-bright-cyan',
		'97': 'ansi-bright-white',
		// Background colors
		'40': 'ansi-bg-black',
		'41': 'ansi-bg-red',
		'42': 'ansi-bg-green',
		'43': 'ansi-bg-yellow',
		'44': 'ansi-bg-blue',
		'45': 'ansi-bg-magenta',
		'46': 'ansi-bg-cyan',
		'47': 'ansi-bg-white',
		// Text styles
		'1': 'ansi-bold',
		'2': 'ansi-dim',
		'3': 'ansi-italic',
		'4': 'ansi-underline',
	};

	// Convert ANSI escape codes to HTML spans with CSS classes
	function ansiToHtml(text: string): string {
		// Strip Docker log stream header bytes (control characters at start of lines)
		// These appear as bytes 0x00-0x02 followed by stream data
		let cleaned = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1A]/g, '');

		// First escape HTML
		let escaped = escapeHtml(cleaned);

		// Match ANSI escape sequences: ESC[ followed by codes and ending with m
		// ESC can be \x1b, \033, or \e
		const ansiRegex = /\x1b\[([0-9;]*)m/g;

		let result = '';
		let lastIndex = 0;
		let openSpans = 0;
		let match;

		while ((match = ansiRegex.exec(escaped)) !== null) {
			// Add text before this match
			result += escaped.slice(lastIndex, match.index);
			lastIndex = ansiRegex.lastIndex;

			const codes = match[1].split(';').filter(c => c !== '');

			for (const code of codes) {
				if (code === '0' || code === '39' || code === '49' || code === '') {
					// Reset code - close all open spans
					while (openSpans > 0) {
						result += '</span>';
						openSpans--;
					}
				} else if (ansiColorMap[code]) {
					result += `<span class="${ansiColorMap[code]}">`;
					openSpans++;
				}
			}
		}

		// Add remaining text
		result += escaped.slice(lastIndex);

		// Close any remaining open spans
		while (openSpans > 0) {
			result += '</span>';
			openSpans--;
		}

		return result;
	}

	// Highlighted logs with search matches and ANSI color support (single container mode)
	let highlightedLogs = $derived(() => {
		// First convert ANSI codes to HTML
		const withAnsi = ansiToHtml(logs || '');
		if (!logSearchQuery.trim()) return withAnsi;

		// For search, we need to highlight matches while preserving HTML tags
		// We'll only highlight text outside of HTML tags
		const query = logSearchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const escapedQuery = escapeHtml(query);

		// Split by HTML tags and only process text parts
		const parts = withAnsi.split(/(<[^>]*>)/);
		const highlighted = parts.map(part => {
			// Skip HTML tags
			if (part.startsWith('<')) return part;
			// Highlight matches in text
			const regex = new RegExp(`(${escapedQuery})`, 'gi');
			return part.replace(regex, '<mark class="search-match">$1</mark>');
		}).join('');

		return highlighted;
	});

	// Format merged logs with container prefixes
	let formattedMergedLogs = $derived(() => {
		return mergedLogs.map(log => {
			const content = ansiToHtml(log.text);
			let highlighted = content;

			if (logSearchQuery.trim()) {
				const query = logSearchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				const escapedQuery = escapeHtml(query);
				const parts = content.split(/(<[^>]*>)/);
				highlighted = parts.map(part => {
					if (part.startsWith('<')) return part;
					const regex = new RegExp(`(${escapedQuery})`, 'gi');
					return part.replace(regex, '<mark class="search-match">$1</mark>');
				}).join('');
			}

			return {
				...log,
				formattedText: highlighted
			};
		});
	});

	// Update match count after render
	$effect(() => {
		// Track highlighted logs to re-run when content changes
		const html = layoutMode === 'grouped' ? formattedMergedLogs() : highlightedLogs();

		if (logSearchQuery && logsRef) {
			setTimeout(() => {
				const matches = logsRef.querySelectorAll('.search-match');
				matchCount = matches.length;
				currentMatchIndex = 0;
				// Highlight first match
				if (matches.length > 0) {
					matches[0].classList.add('current-match');
					matches[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
				}
			}, 100);
		} else {
			matchCount = 0;
			currentMatchIndex = 0;
		}
	});


	// Scroll to bottom when logs change (for initial load or auto-scroll)
	$effect(() => {
		// Track logs to trigger on content change
		const _ = layoutMode === 'grouped' ? mergedLogs : logs;
		if (logsRef && (logs || mergedLogs.length > 0) && (isInitialLoad || autoScroll)) {
			// Use tick/setTimeout to wait for DOM update
			setTimeout(() => {
				if (logsRef) {
					logsRef.scrollTop = logsRef.scrollHeight;
					if (isInitialLoad) {
						isInitialLoad = false;
					}
				}
			}, 100);
		}
	});

	onMount(() => {
		// All initialization is handled in currentEnvironment.subscribe
		// This just sets up the refresh interval
		containerInterval = setInterval(fetchContainers, 10000);
		// Note: In Svelte 5, cleanup must be in onDestroy, not returned from onMount
	});

	onDestroy(() => {
		if (containerInterval) {
			clearInterval(containerInterval);
			containerInterval = null;
		}
		stopStreaming();
	});
</script>

{#if $environments.length === 0 || !$currentEnvironment}
	<div class="flex flex-col flex-1 min-h-0 h-full">
		<PageHeader icon={ScrollText} title="Logs" class="h-9 mb-3" />
		<NoEnvironment />
	</div>
{:else}
<div class="flex flex-col flex-1 min-h-0 h-full gap-3">
	<!-- Header with container selector -->
	<div class="flex items-center gap-4 h-9">
		<PageHeader icon={ScrollText} title="Logs" />
		<!-- Layout toggle - fixed position after title -->
		<ToggleGroup
			bind:value={layoutMode}
			options={layoutModeOptions}
			onchange={handleLayoutModeChange}
		/>
		{#if layoutMode === 'single'}
			<div class="relative flex-1 max-w-md">
				<!-- Search input - always visible, shows selected container name as placeholder -->
				<div class="relative">
					<Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
					<Input
						type="text"
						placeholder={selectedContainer ? `${selectedContainer.name} (${selectedContainer.image})` : "Search containers..."}
						bind:value={searchQuery}
						onfocus={handleInputFocus}
						onblur={handleInputBlur}
						onkeydown={handleInputKeydown}
						class="pl-10 pr-10 h-9 {selectedContainer ? 'placeholder:text-foreground' : ''}"
					/>
					<ChevronDown class="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
				</div>

				<!-- Dropdown -->
				{#if dropdownOpen}
					<div class="absolute top-full left-0 right-0 mt-1 border rounded-md bg-popover shadow-lg z-50 max-h-64 overflow-auto">
						{#if filteredContainers().length === 0}
							<div class="px-3 py-2 text-sm text-muted-foreground">
								{containers.length === 0 ? 'No containers' : 'No matches found'}
							</div>
						{:else}
							{#each filteredContainers() as container}
								{@const isCurrentSelection = selectedContainer?.id === container.id}
								<button
									type="button"
									onclick={() => selectContainer(container)}
									class="w-full px-3 py-2 text-left text-sm hover:bg-muted transition-colors flex items-center gap-2 {isCurrentSelection ? 'bg-muted' : ''}"
								>
									<Box class="w-3.5 h-3.5 shrink-0 {container.state === 'running' ? 'text-green-500' : 'text-muted-foreground'}" />
									<span class="font-medium truncate">{container.name}</span>
									<span class="text-muted-foreground text-xs truncate">({container.image})</span>
									{#if isCurrentSelection}
										<span class="ml-auto text-xs text-muted-foreground">current</span>
									{/if}
								</button>
							{/each}
						{/if}
					</div>
				{/if}
			</div>
		{:else if layoutMode === 'multi'}
			<!-- Multi layout - container name now shown in logs header bar -->
			<div class="flex-1"></div>
		{:else}
			<!-- Grouped layout - minimal header -->
			<div class="flex-1"></div>
		{/if}
	</div>

	<!-- Logs output - full height -->
	<div class="flex-1 min-h-0 flex gap-3">
		<!-- Container sidebar for multi/grouped layout -->
		{#if layoutMode === 'multi' || layoutMode === 'grouped'}
			<div class="w-64 shrink-0 border rounded-lg overflow-hidden flex flex-col bg-background">
				<div class="px-3 py-2 border-b bg-muted/30">
					<div class="relative">
						<Search class="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
						<Input
							type="text"
							placeholder="Filter containers..."
							bind:value={searchQuery}
							class="pl-8 h-8 text-sm"
						/>
					</div>
				</div>
				{#if layoutMode === 'grouped'}
					<!-- Grouped mode selection controls -->
					<div class="px-2 py-1.5 border-b bg-muted/20 flex items-center gap-2">
						<button
							type="button"
							onclick={selectAllContainers}
							class="text-2xs text-muted-foreground hover:text-foreground transition-colors"
						>
							Select all
						</button>
						<span class="text-muted-foreground">|</span>
						<button
							type="button"
							onclick={clearContainerSelection}
							class="text-2xs text-muted-foreground hover:text-foreground transition-colors"
						>
							Clear
						</button>
					</div>
				{/if}
				<div class="flex-1 overflow-auto">
					{#if layoutMode === 'grouped'}
						{@const validFavoriteGroups = favoriteGroups.filter(g => g?.name && g?.containers)}
						{#if validFavoriteGroups.length > 0}
							<!-- Saved groups section (grouped mode only) -->
							<div class="border-b border-purple-500/30 bg-purple-500/5">
								<div class="px-2 py-1 text-2xs font-medium text-purple-600 dark:text-purple-400 flex items-center gap-1">
									<FolderHeart class="w-2.5 h-2.5" />
									Saved groups
								</div>
								{#each validFavoriteGroups as savedGroup, idx (savedGroup.name || `group-${idx}`)}
									<div
										class="saved-group-item w-full px-1.5 py-1 text-left text-xs hover:bg-purple-500/10 transition-colors flex items-center gap-1.5 border-b border-purple-500/20 cursor-pointer"
										onclick={() => loadFavoriteGroup(savedGroup)}
										onkeydown={(e) => e.key === 'Enter' && loadFavoriteGroup(savedGroup)}
										role="button"
										tabindex="0"
									>
										<Layers class="w-3 h-3 shrink-0 text-purple-500" />
										<div class="flex-1 min-w-0">
											<div class="font-medium truncate text-xs leading-tight">{savedGroup.name}</div>
											<div class="text-2xs text-muted-foreground truncate leading-tight">{savedGroup.containers.length} container{savedGroup.containers.length !== 1 ? 's' : ''}</div>
										</div>
										<button
											type="button"
											onclick={(e) => { e.stopPropagation(); deleteFavoriteGroup(savedGroup.name); }}
											class="p-0.5 rounded hover:bg-red-500/20 transition-colors opacity-0 [.saved-group-item:hover_&]:opacity-100"
											title="Delete group"
										>
											<Trash2 class="w-2.5 h-2.5 text-muted-foreground hover:text-red-500" />
										</button>
									</div>
								{/each}
							</div>
						{/if}
					{/if}
					{#if filteredContainers().length === 0}
						<div class="px-3 py-4 text-sm text-muted-foreground text-center">
							{containers.length === 0 ? 'No containers' : 'No matches found'}
						</div>
					{:else}
						<!-- Favorites section (only in multi mode) -->
						{#if layoutMode === 'multi' && favoriteContainers().length > 0}
							<div class="border-b border-amber-500/30 bg-amber-500/5">
								<div class="px-2 py-1 text-2xs font-medium text-amber-600 dark:text-amber-400 flex items-center gap-1">
									<Star class="w-2.5 h-2.5 fill-current" />
									Favorites
								</div>
								{#each favoriteContainers() as container}
									{@const isMultiSelected = multiModeSelections.has(container.id)}
									<div
										class="group w-full px-1.5 py-1 text-left text-xs hover:bg-amber-500/10 transition-colors flex items-center gap-1.5 border-b border-amber-500/20 cursor-pointer {selectedContainer?.id === container.id ? 'bg-amber-500/15' : ''} {dragOverFavorite === container.name ? 'bg-amber-500/20 border-t-2 border-t-amber-500' : ''} {draggedFavorite === container.name ? 'opacity-50' : ''}"
										onclick={() => selectContainer(container)}
										onkeydown={(e) => e.key === 'Enter' && selectContainer(container)}
										role="button"
										tabindex="0"
										draggable="true"
										ondragstart={(e) => handleDragStart(e, container.name)}
										ondragover={(e) => handleDragOver(e, container.name)}
										ondragleave={handleDragLeave}
										ondragend={handleDragEnd}
										ondrop={(e) => handleDrop(e, container.name)}
									>
										<!-- Multi-select checkbox -->
										<button
											type="button"
											onclick={(e) => toggleMultiModeSelection(container.id, e)}
											class="w-4 h-4 shrink-0 flex items-center justify-center"
											title="Select for merge"
										>
											{#if isMultiSelected}
												<div class="w-3.5 h-3.5 rounded border-2 flex items-center justify-center border-blue-500 bg-blue-500/20">
													<Check class="w-2.5 h-2.5 text-blue-500" />
												</div>
											{:else}
												<div class="w-3.5 h-3.5 rounded border-2 border-muted-foreground/30 opacity-30 group-hover:opacity-100"></div>
											{/if}
										</button>
										<GripVertical class="w-3 h-3 shrink-0 text-muted-foreground/50 cursor-grab active:cursor-grabbing" />
										<Box class="w-3 h-3 shrink-0 {container.state === 'running' ? 'text-green-500' : 'text-muted-foreground'}" />
										<div class="flex-1 min-w-0">
											<div class="font-medium truncate text-xs leading-tight">{container.name}</div>
											<div class="text-2xs text-muted-foreground truncate leading-tight">{container.image}</div>
										</div>
										<button
											type="button"
											onclick={(e) => toggleFavorite(container.name, e)}
											class="p-0.5 rounded hover:bg-amber-500/20 transition-colors"
											title="Remove from favorites"
										>
											<Star class="w-2.5 h-2.5 text-amber-500 fill-amber-500" />
										</button>
									</div>
								{/each}
							</div>
						{/if}
						<!-- Favorites section (in grouped mode too) -->
						{#if layoutMode === 'grouped' && favoriteContainers().length > 0}
							<div class="border-b border-amber-500/30 bg-amber-500/5">
								<div class="px-2 py-1 text-2xs font-medium text-amber-600 dark:text-amber-400 flex items-center gap-1">
									<Star class="w-2.5 h-2.5 fill-current" />
									Favorites
								</div>
								{#each favoriteContainers() as container}
									{@const isSelected = selectedContainerIds.has(container.id)}
									{@const containerColor = groupedContainerInfo.get(container.id)?.color}
									<div
										class="group w-full px-1.5 py-1 text-left text-xs hover:bg-amber-500/10 transition-colors flex items-center gap-1.5 border-b border-amber-500/20 cursor-pointer {isSelected ? 'bg-amber-500/15' : ''}"
										onclick={() => toggleContainerSelection(container.id)}
										onkeydown={(e) => e.key === 'Enter' && toggleContainerSelection(container.id)}
										role="button"
										tabindex="0"
									>
										<div class="w-4 h-4 shrink-0 flex items-center justify-center">
											{#if isSelected}
												<div class="w-3.5 h-3.5 rounded border-2 flex items-center justify-center" style="border-color: {containerColor || '#60a5fa'}; background-color: {containerColor || '#60a5fa'}20">
													<Check class="w-2.5 h-2.5" style="color: {containerColor || '#60a5fa'}" />
												</div>
											{:else}
												<div class="w-3.5 h-3.5 rounded border-2 border-muted-foreground/30"></div>
											{/if}
										</div>
										<Box class="w-3 h-3 shrink-0 {container.state === 'running' ? 'text-green-500' : 'text-muted-foreground'}" />
										<div class="flex-1 min-w-0">
											<div class="font-medium truncate text-xs leading-tight">{container.name}</div>
											<div class="text-2xs text-muted-foreground truncate leading-tight">{container.image}</div>
										</div>
										<button
											type="button"
											onclick={(e) => toggleFavorite(container.name, e)}
											class="p-0.5 rounded hover:bg-amber-500/20 transition-colors"
											title="Remove from favorites"
										>
											<Star class="w-2.5 h-2.5 text-amber-500 fill-amber-500" />
										</button>
									</div>
								{/each}
							</div>
						{/if}
						<!-- All containers section -->
						{#if layoutMode === 'multi' ? nonFavoriteContainers().length > 0 : (layoutMode === 'grouped' ? nonFavoriteContainers().length > 0 : filteredContainers().length > 0)}
							{#if (layoutMode === 'multi' || layoutMode === 'grouped') && favoriteContainers().length > 0}
								<div class="px-2 py-1 text-2xs font-medium text-muted-foreground border-b border-border/50">
									All containers
								</div>
							{/if}
							{#each layoutMode === 'multi' || layoutMode === 'grouped' ? nonFavoriteContainers() : filteredContainers() as container}
								{@const isSelected = layoutMode === 'grouped' ? selectedContainerIds.has(container.id) : selectedContainer?.id === container.id}
								{@const isMultiSelected = multiModeSelections.has(container.id)}
								{@const containerColor = groupedContainerInfo.get(container.id)?.color}
								<div
									class="group w-full px-1.5 py-1 text-left text-xs hover:bg-muted transition-colors flex items-center gap-1.5 border-b border-border/50 cursor-pointer {isSelected ? 'bg-muted' : ''}"
									onclick={() => layoutMode === 'grouped' ? toggleContainerSelection(container.id) : selectContainer(container)}
									onkeydown={(e) => e.key === 'Enter' && (layoutMode === 'grouped' ? toggleContainerSelection(container.id) : selectContainer(container))}
									role="button"
									tabindex="0"
								>
									{#if layoutMode === 'grouped'}
										<div class="w-4 h-4 shrink-0 flex items-center justify-center">
											{#if isSelected}
												<div class="w-3.5 h-3.5 rounded border-2 flex items-center justify-center" style="border-color: {containerColor || '#60a5fa'}; background-color: {containerColor || '#60a5fa'}20">
													<Check class="w-2.5 h-2.5" style="color: {containerColor || '#60a5fa'}" />
												</div>
											{:else}
												<div class="w-3.5 h-3.5 rounded border-2 border-muted-foreground/30"></div>
											{/if}
										</div>
									{:else if layoutMode === 'multi'}
										<!-- Multi-select checkbox -->
										<button
											type="button"
											onclick={(e) => toggleMultiModeSelection(container.id, e)}
											class="w-4 h-4 shrink-0 flex items-center justify-center"
											title="Select for merge"
										>
											{#if isMultiSelected}
												<div class="w-3.5 h-3.5 rounded border-2 flex items-center justify-center border-blue-500 bg-blue-500/20">
													<Check class="w-2.5 h-2.5 text-blue-500" />
												</div>
											{:else}
												<div class="w-3.5 h-3.5 rounded border-2 border-muted-foreground/30 opacity-30 group-hover:opacity-100"></div>
											{/if}
										</button>
									{/if}
									<Box class="w-3 h-3 shrink-0 {container.state === 'running' ? 'text-green-500' : 'text-muted-foreground'}" />
									<div class="flex-1 min-w-0">
										<div class="font-medium truncate text-xs leading-tight">{container.name}</div>
										<div class="text-2xs text-muted-foreground truncate leading-tight">{container.image}</div>
									</div>
									{#if layoutMode === 'multi'}
										<button
											type="button"
											onclick={(e) => toggleFavorite(container.name, e)}
											class="p-0.5 rounded hover:bg-amber-500/20 transition-colors opacity-30 group-hover:opacity-100"
											title="Add to favorites"
										>
											<Star class="w-2.5 h-2.5 text-muted-foreground hover:text-amber-500" />
										</button>
									{/if}
								</div>
							{/each}
						{/if}
					{/if}
				</div>
				{#if layoutMode === 'grouped'}
					<!-- Grouped mode footer -->
					<div class="px-2 py-2 border-t bg-muted/30 flex flex-col gap-2">
						<div class="flex items-center justify-between text-xs text-muted-foreground">
							<span>{selectedContainerIds.size} selected</span>
							<span>{containers.length} total</span>
						</div>
						{#if selectedContainerIds.size > 0}
							<!-- Save group section -->
							{#if showSaveGroupInput}
								<div class="flex items-center gap-1">
									<input
										type="text"
										placeholder="Group name..."
										bind:value={newGroupName}
										onkeydown={(e) => e.key === 'Enter' && saveCurrentGroup()}
										use:focusOnMount
										class="h-6 text-xs flex-1 px-2 rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
									/>
									<button
										type="button"
										onclick={saveCurrentGroup}
										disabled={!newGroupName.trim()}
										class="h-6 w-6 flex items-center justify-center rounded hover:bg-green-500/20 text-muted-foreground hover:text-green-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
										title="Save"
									>
										<Check class="w-3.5 h-3.5" />
									</button>
									<button
										type="button"
										onclick={() => { showSaveGroupInput = false; newGroupName = ''; }}
										class="h-6 w-6 flex items-center justify-center rounded hover:bg-red-500/20 text-muted-foreground hover:text-red-500 transition-colors"
										title="Cancel"
									>
										<X class="w-3.5 h-3.5" />
									</button>
								</div>
							{:else}
								<Button size="sm" variant="outline" onclick={() => showSaveGroupInput = true} class="w-full h-7 gap-1.5 text-xs">
									<Save class="w-3 h-3" />
									Save group
								</Button>
							{/if}
						{/if}
					</div>
				{:else}
					<!-- Multi mode footer -->
					<div class="px-2 py-2 border-t bg-muted/30 flex flex-col gap-2">
						<div class="flex items-center justify-between text-xs text-muted-foreground">
							{#if multiModeSelections.size > 0}
								<span>{multiModeSelections.size} selected</span>
								<button
									type="button"
									onclick={clearMultiModeSelection}
									class="text-2xs text-muted-foreground hover:text-foreground transition-colors"
								>
									Clear
								</button>
							{:else}
								<span>{containers.length} container{containers.length !== 1 ? 's' : ''}</span>
							{/if}
						</div>
						{#if multiModeSelections.size >= 2}
							<Button size="sm" variant="default" onclick={mergeSelectedContainers} class="w-full h-7 gap-1.5 text-xs">
								<Layers class="w-3 h-3" />
								Merge {multiModeSelections.size} containers
							</Button>
						{/if}
					</div>
				{/if}
			</div>
		{/if}

		<!-- Logs panel -->
		<div class="flex-1 min-h-0 border rounded-lg overflow-hidden flex flex-col transition-colors {darkMode ? 'bg-zinc-950 border-zinc-800' : 'bg-gray-50 border-gray-300'}">
			{#if layoutMode === 'grouped'}
				{#if selectedContainerIds.size === 0}
					<div class="flex items-center justify-center h-full text-muted-foreground">
						Select containers from the list to view merged logs
					</div>
				{:else}
					<!-- Header bar for grouped mode -->
					<div class="flex items-center justify-between px-3 py-1.5 border-b shrink-0 transition-colors {darkMode ? 'border-zinc-800 bg-zinc-900/50' : 'border-gray-300 bg-gray-100'}">
						<div class="flex items-center gap-2 min-w-[100px]">
							{#if streamingEnabled}
								{#if isConnected}
									<div class="flex items-center gap-1.5" title="Connected - Live streaming">
										<Wifi class="w-3.5 h-3.5 text-green-500" />
										<span class="text-xs text-green-500 font-medium">Live</span>
									</div>
								{:else if loading}
									<div class="flex items-center gap-1.5" title="Connecting...">
										<RefreshCw class="w-3.5 h-3.5 animate-spin {darkMode ? 'text-amber-500' : 'text-amber-600'}" />
										<span class="text-xs {darkMode ? 'text-amber-500' : 'text-amber-600'}">Connecting...</span>
									</div>
								{:else if connectionError}
									<button onclick={retryConnection} class="flex items-center gap-1.5 hover:opacity-80" title={connectionError}>
										<WifiOff class="w-3.5 h-3.5 {darkMode ? 'text-zinc-500' : 'text-gray-400'}" />
										<span class="text-xs {darkMode ? 'text-zinc-500' : 'text-gray-400'}">Disconnected</span>
									</button>
								{/if}
							{:else}
								<div class="flex items-center gap-1.5" title="Streaming paused">
									<Pause class="w-3.5 h-3.5 {darkMode ? 'text-zinc-500' : 'text-gray-400'}" />
									<span class="text-xs {darkMode ? 'text-zinc-500' : 'text-gray-400'}">Paused</span>
								</div>
							{/if}
							<!-- Stack name / container name and color legend -->
							<div class="flex items-center gap-1.5 ml-2">
								{#if stackName}
									<span class="text-xs font-medium {darkMode ? 'text-zinc-300' : 'text-gray-700'}">{stackName}</span>
								{:else if groupedContainerInfo.size === 1}
									{@const singleContainer = Array.from(groupedContainerInfo.values())[0]}
									<div class="flex items-center gap-1">
										<div class="w-2 h-2 rounded-full" style="background-color: {singleContainer.color}"></div>
										<span class="text-xs font-medium {darkMode ? 'text-zinc-300' : 'text-gray-700'}">{singleContainer.name}</span>
									</div>
								{/if}
								{#if stackName || groupedContainerInfo.size > 1}
									{#each Array.from(groupedContainerInfo.entries()) as [id, info]}
										<div class="flex items-center gap-0.5" title={info.name}>
											<div class="w-2 h-2 rounded-full" style="background-color: {info.color}"></div>
										</div>
									{/each}
								{/if}
							</div>
						</div>
						<div class="flex items-center gap-3">
							<button
								onclick={toggleStreaming}
								class="flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors {streamingEnabled ? (darkMode ? 'bg-amber-500/20 ring-1 ring-amber-500/50 text-amber-400' : 'bg-amber-500/30 ring-1 ring-amber-600/50 text-amber-700') : darkMode ? 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-200'}"
								title={streamingEnabled ? 'Pause live streaming' : 'Resume live streaming'}
							>
								{#if streamingEnabled}
									<Pause class="w-3 h-3" />
									<span>Pause</span>
								{:else}
									<Play class="w-3 h-3" />
									<span>Stream</span>
								{/if}
							</button>
							<button
								onclick={() => { autoScroll = !autoScroll; saveState(); }}
								class="flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors {autoScroll ? (darkMode ? 'bg-amber-500/20 ring-1 ring-amber-500/50 text-amber-400' : 'bg-amber-500/30 ring-1 ring-amber-600/50 text-amber-700') : darkMode ? 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-200'}"
								title="Toggle auto-scroll"
							>
								<ArrowDownToLine class="w-3 h-3" />
								<span>Auto-scroll</span>
							</button>
							<Select.Root type="single" value={String(fontSize)} onValueChange={(v) => { fontSize = Number(v); saveState(); }}>
								<Select.Trigger class="!h-5 !py-0 w-14 text-xs px-1.5 [&_svg]:size-3 {darkMode ? 'bg-zinc-800 border-zinc-700 text-zinc-300' : 'bg-white border-gray-300 text-gray-700'}">
									<span>{fontSize}px</span>
								</Select.Trigger>
								<Select.Content>
									{#each fontSizeOptions as size}
										<Select.Item value={String(size)} label="{size}px" class="pe-2 [&>span:first-child]:hidden">{size}px</Select.Item>
									{/each}
								</Select.Content>
							</Select.Root>
							<button
								onclick={() => { wordWrap = !wordWrap; saveState(); }}
								class="flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors {wordWrap ? (darkMode ? 'bg-amber-500/20 ring-1 ring-amber-500/50 text-amber-400' : 'bg-amber-500/30 ring-1 ring-amber-600/50 text-amber-700') : darkMode ? 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-200'}"
								title="Toggle word wrap"
							>
								<WrapText class="w-3 h-3" />
								<span>Wrap</span>
							</button>
							<button onclick={toggleTheme} class="p-1 rounded transition-colors {darkMode ? 'hover:bg-zinc-800' : 'hover:bg-gray-200'}" title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}>
								{#if darkMode}
									<Sun class="w-3 h-3 {darkMode ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
								{:else}
									<Moon class="w-3 h-3 {darkMode ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
								{/if}
							</button>
							{#if logSearchActive}
								<div class="flex items-center gap-1.5 rounded px-2 py-1 {darkMode ? 'bg-zinc-800' : 'bg-gray-200'}">
									<Search class="w-3 h-3 text-amber-400" />
									<input
										bind:this={logSearchInputRef}
										type="text"
										placeholder="Search..."
										bind:value={logSearchQuery}
										onkeydown={handleLogSearchKeydown}
										class="bg-transparent border-none outline-none text-xs w-28 {darkMode ? 'text-zinc-200 placeholder:text-zinc-500' : 'text-gray-800 placeholder:text-gray-400'}"
									/>
									{#if matchCount > 0}
										<span class="text-xs {darkMode ? 'text-zinc-400' : 'text-gray-500'}">{currentMatchIndex + 1}/{matchCount}</span>
									{:else if logSearchQuery}
										<span class="text-xs {darkMode ? 'text-zinc-500' : 'text-gray-400'}">0/0</span>
									{/if}
									<button onclick={() => navigateMatch('prev')} class="p-0.5 rounded transition-colors {darkMode ? 'hover:bg-zinc-700' : 'hover:bg-gray-300'}" title="Previous match">
										<ChevronUp class="w-3 h-3 {darkMode ? 'text-zinc-400' : 'text-gray-500'}" />
									</button>
									<button onclick={() => navigateMatch('next')} class="p-0.5 rounded transition-colors {darkMode ? 'hover:bg-zinc-700' : 'hover:bg-gray-300'}" title="Next match">
										<ChevronDown class="w-3 h-3 {darkMode ? 'text-zinc-400' : 'text-gray-500'}" />
									</button>
									<button onclick={closeLogSearch} class="p-0.5 rounded transition-colors {darkMode ? 'hover:bg-zinc-700' : 'hover:bg-gray-300'}" title="Close search">
										<X class="w-3 h-3 {darkMode ? 'text-zinc-400' : 'text-gray-500'}" />
									</button>
								</div>
							{:else}
								<button onclick={toggleLogSearch} class="p-1 rounded transition-colors {darkMode ? 'hover:bg-zinc-800' : 'hover:bg-gray-200'}" title="Search logs">
									<Search class="w-3 h-3 {darkMode ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
								</button>
							{/if}
							<button onclick={copyLogs} class="p-1 rounded transition-colors {darkMode ? 'hover:bg-zinc-800' : 'hover:bg-gray-200'}" title="Copy logs">
								<Copy class="w-3 h-3 {darkMode ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
							</button>
							<button onclick={downloadLogs} class="p-1 rounded transition-colors {darkMode ? 'hover:bg-zinc-800' : 'hover:bg-gray-200'}" title="Download logs">
								<Download class="w-3 h-3 {darkMode ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
							</button>
						</div>
					</div>
					<div class="flex-1 overflow-auto p-4 relative" bind:this={logsRef}>
						{#if loading && mergedLogs.length === 0}
							<div class="absolute inset-0 flex items-center justify-center z-10">
								<RefreshCw class="w-8 h-8 animate-spin {darkMode ? 'text-zinc-400' : 'text-gray-500'}" />
							</div>
						{:else if loading}
							<div class="absolute inset-0 flex items-center justify-center bg-black/30 z-10">
								<RefreshCw class="w-8 h-8 animate-spin {darkMode ? 'text-zinc-400' : 'text-gray-500'}" />
							</div>
						{/if}
						<div class="font-mono {wordWrap ? 'whitespace-pre-wrap' : 'whitespace-pre'}" style="font-size: {fontSize}px;">
							{#each formattedMergedLogs() as log}
								<div class="flex">
									<span class="shrink-0 font-semibold mr-2" style="color: {log.color}">[{log.containerName}]</span>
									<span class="{darkMode ? 'text-zinc-50' : 'text-gray-900'}">{@html log.formattedText}</span>
								</div>
							{/each}
						</div>
					</div>
				{/if}
			{:else if !selectedContainer}
				<div class="flex items-center justify-center h-full text-muted-foreground">
					{layoutMode === 'multi' ? 'Select a container from the list' : 'Select a container to view logs'}
				</div>
			{:else}
			<!-- Header bar inside black area -->
			<div class="flex items-center justify-between px-3 py-1.5 border-b shrink-0 transition-colors {darkMode ? 'border-zinc-800 bg-zinc-900/50' : 'border-gray-300 bg-gray-100'}">
				<div class="flex items-center gap-2 min-w-[100px]">
					<!-- Connection status indicator -->
					{#if streamingEnabled}
						{#if isConnected}
							<div class="flex items-center gap-1.5 transition-opacity duration-300" title="Connected - Live streaming">
								<Wifi class="w-3.5 h-3.5 text-green-500" />
								<span class="text-xs text-green-500 font-medium">Live</span>
							</div>
						{:else if loading}
							<div class="flex items-center gap-1.5 transition-opacity duration-300" title="Connecting...">
								<RefreshCw class="w-3.5 h-3.5 animate-spin {darkMode ? 'text-amber-500' : 'text-amber-600'}" />
								<span class="text-xs {darkMode ? 'text-amber-500' : 'text-amber-600'}">Connecting...</span>
							</div>
						{:else if connectionError}
							<button
								onclick={retryConnection}
								class="flex items-center gap-1.5 transition-opacity duration-300 hover:opacity-80"
								title={connectionError}
							>
								<WifiOff class="w-3.5 h-3.5 {darkMode ? 'text-zinc-500' : 'text-gray-400'}" />
								<span class="text-xs {darkMode ? 'text-zinc-500' : 'text-gray-400'}">Disconnected</span>
							</button>
						{:else}
							<div class="flex items-center gap-1.5 transition-opacity duration-300" title="Disconnected">
								<WifiOff class="w-3.5 h-3.5 {darkMode ? 'text-zinc-500' : 'text-gray-400'}" />
								<span class="text-xs {darkMode ? 'text-zinc-500' : 'text-gray-400'}">Offline</span>
							</div>
						{/if}
					{:else}
						<div class="flex items-center gap-1.5 transition-opacity duration-300" title="Streaming paused">
							<Pause class="w-3.5 h-3.5 {darkMode ? 'text-zinc-500' : 'text-gray-400'}" />
							<span class="text-xs {darkMode ? 'text-zinc-500' : 'text-gray-400'}">Paused</span>
						</div>
					{/if}
					<!-- Container name -->
					{#if selectedContainer}
						<div class="flex items-center gap-1 ml-2">
							<span class="text-xs font-medium {darkMode ? 'text-zinc-300' : 'text-gray-700'}">{selectedContainer.name}</span>
						</div>
					{/if}
				</div>
				<div class="flex items-center gap-3">
					<!-- Streaming toggle -->
					<button
						onclick={toggleStreaming}
						class="flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors {streamingEnabled ? (darkMode ? 'bg-amber-500/20 ring-1 ring-amber-500/50 text-amber-400' : 'bg-amber-500/30 ring-1 ring-amber-600/50 text-amber-700') : darkMode ? 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-200'}"
						title={streamingEnabled ? 'Pause live streaming' : 'Resume live streaming'}
					>
						{#if streamingEnabled}
							<Pause class="w-3 h-3" />
							<span>Pause</span>
						{:else}
							<Play class="w-3 h-3" />
							<span>Stream</span>
						{/if}
					</button>
					<button
						onclick={() => { autoScroll = !autoScroll; saveState(); }}
						class="flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors {autoScroll ? (darkMode ? 'bg-amber-500/20 ring-1 ring-amber-500/50 text-amber-400' : 'bg-amber-500/30 ring-1 ring-amber-600/50 text-amber-700') : darkMode ? 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-200'}"
						title="Toggle auto-scroll"
					>
						<ArrowDownToLine class="w-3 h-3" />
						<span>Auto-scroll</span>
					</button>
					<Select.Root type="single" value={String(fontSize)} onValueChange={(v) => { fontSize = Number(v); saveState(); }}>
						<Select.Trigger class="!h-5 !py-0 w-14 text-xs px-1.5 [&_svg]:size-3 {darkMode ? 'bg-zinc-800 border-zinc-700 text-zinc-300' : 'bg-white border-gray-300 text-gray-700'}">
							<span>{fontSize}px</span>
						</Select.Trigger>
						<Select.Content>
							{#each fontSizeOptions as size}
								<Select.Item value={String(size)} label="{size}px" class="pe-2 [&>span:first-child]:hidden">{size}px</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
					<button
						onclick={() => { wordWrap = !wordWrap; saveState(); }}
						class="flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors {wordWrap ? (darkMode ? 'bg-amber-500/20 ring-1 ring-amber-500/50 text-amber-400' : 'bg-amber-500/30 ring-1 ring-amber-600/50 text-amber-700') : darkMode ? 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-200'}"
						title="Toggle word wrap"
					>
						<WrapText class="w-3 h-3" />
						<span>Wrap</span>
					</button>
					<!-- Theme toggle -->
					<button
						onclick={toggleTheme}
						class="p-1 rounded transition-colors {darkMode ? 'hover:bg-zinc-800' : 'hover:bg-gray-200'}"
						title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
					>
						{#if darkMode}
							<Sun class="w-3 h-3 {darkMode ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
						{:else}
							<Moon class="w-3 h-3 {darkMode ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
						{/if}
					</button>
					{#if logSearchActive}
						<div class="flex items-center gap-1.5 rounded px-2 py-1 {darkMode ? 'bg-zinc-800' : 'bg-gray-200'}">
							<Search class="w-3 h-3 text-amber-400" />
							<input
								bind:this={logSearchInputRef}
								type="text"
								placeholder="Search..."
								bind:value={logSearchQuery}
								onkeydown={handleLogSearchKeydown}
								class="bg-transparent border-none outline-none text-xs w-28 {darkMode ? 'text-zinc-200 placeholder:text-zinc-500' : 'text-gray-800 placeholder:text-gray-400'}"
							/>
							{#if matchCount > 0}
								<span class="text-xs {darkMode ? 'text-zinc-400' : 'text-gray-500'}">{currentMatchIndex + 1}/{matchCount}</span>
							{:else if logSearchQuery}
								<span class="text-xs {darkMode ? 'text-zinc-500' : 'text-gray-400'}">0/0</span>
							{/if}
							<button
								onclick={() => navigateMatch('prev')}
								class="p-0.5 rounded transition-colors {darkMode ? 'hover:bg-zinc-700' : 'hover:bg-gray-300'}"
								title="Previous match (Shift+Enter)"
							>
								<ChevronUp class="w-3 h-3 {darkMode ? 'text-zinc-400' : 'text-gray-500'}" />
							</button>
							<button
								onclick={() => navigateMatch('next')}
								class="p-0.5 rounded transition-colors {darkMode ? 'hover:bg-zinc-700' : 'hover:bg-gray-300'}"
								title="Next match (Enter)"
							>
								<ChevronDown class="w-3 h-3 {darkMode ? 'text-zinc-400' : 'text-gray-500'}" />
							</button>
							<button
								onclick={closeLogSearch}
								class="p-0.5 rounded transition-colors {darkMode ? 'hover:bg-zinc-700' : 'hover:bg-gray-300'}"
								title="Close search (Esc)"
							>
								<X class="w-3 h-3 {darkMode ? 'text-zinc-400' : 'text-gray-500'}" />
							</button>
						</div>
					{:else}
						<button
							onclick={toggleLogSearch}
							class="p-1 rounded transition-colors {darkMode ? 'hover:bg-zinc-800' : 'hover:bg-gray-200'}"
							title="Search logs (Ctrl+F)"
						>
							<Search class="w-3 h-3 {darkMode ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
						</button>
					{/if}
					<button
						onclick={copyLogs}
						class="p-1 rounded transition-colors {darkMode ? 'hover:bg-zinc-800' : 'hover:bg-gray-200'}"
						title="Copy logs"
					>
						<Copy class="w-3 h-3 {darkMode ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
					</button>
					<button
						onclick={downloadLogs}
						class="p-1 rounded transition-colors {darkMode ? 'hover:bg-zinc-800' : 'hover:bg-gray-200'}"
						title="Download logs"
					>
						<Download class="w-3 h-3 {darkMode ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
					</button>
					<button
						onclick={() => fetchLogs()}
						class="p-1 rounded transition-colors {darkMode ? 'hover:bg-zinc-800' : 'hover:bg-gray-200'}"
						title="Refresh logs"
					>
						<RefreshCw class="w-3 h-3 {darkMode ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
					</button>
				</div>
			</div>
			{#if loading && !logs}
				<div class="flex items-center justify-center flex-1 text-muted-foreground">
					<RefreshCw class="w-5 h-5 animate-spin mr-2" />
					Loading logs...
				</div>
			{:else}
				<div bind:this={logsRef} class="flex-1 overflow-auto p-4">
					<pre class="font-mono {wordWrap ? 'whitespace-pre-wrap' : 'whitespace-pre'} {darkMode ? 'text-zinc-50' : 'text-gray-900'}" style="font-size: {fontSize}px;">{@html highlightedLogs()}</pre>
				</div>
			{/if}
		{/if}
		</div>
	</div>
</div>
{/if}

<style>
	:global(.search-match) {
		background-color: rgba(234, 179, 8, 0.4);
		color: #fef3c7;
		border-radius: 2px;
		padding: 1px 2px;
		box-shadow: 0 0 4px rgba(234, 179, 8, 0.5);
	}
	:global(.search-match.current-match) {
		background-color: rgba(234, 179, 8, 0.8);
		color: #1a1a1a;
		font-weight: 600;
		box-shadow: 0 0 8px rgba(234, 179, 8, 0.9), 0 0 16px rgba(234, 179, 8, 0.5);
		outline: 2px solid rgb(250, 204, 21);
	}

	/* ANSI color classes - foreground colors */
	:global(.ansi-black) { color: #3f3f46; }
	:global(.ansi-red) { color: #ef4444; }
	:global(.ansi-green) { color: #22c55e; }
	:global(.ansi-yellow) { color: #eab308; }
	:global(.ansi-blue) { color: #3b82f6; }
	:global(.ansi-magenta) { color: #d946ef; }
	:global(.ansi-cyan) { color: #06b6d4; }
	:global(.ansi-white) { color: #e4e4e7; }

	/* Bright foreground colors */
	:global(.ansi-bright-black) { color: #71717a; }
	:global(.ansi-bright-red) { color: #f87171; }
	:global(.ansi-bright-green) { color: #4ade80; }
	:global(.ansi-bright-yellow) { color: #facc15; }
	:global(.ansi-bright-blue) { color: #60a5fa; }
	:global(.ansi-bright-magenta) { color: #e879f9; }
	:global(.ansi-bright-cyan) { color: #22d3ee; }
	:global(.ansi-bright-white) { color: #fafafa; }

	/* Background colors */
	:global(.ansi-bg-black) { background-color: #18181b; }
	:global(.ansi-bg-red) { background-color: #dc2626; }
	:global(.ansi-bg-green) { background-color: #16a34a; }
	:global(.ansi-bg-yellow) { background-color: #ca8a04; }
	:global(.ansi-bg-blue) { background-color: #2563eb; }
	:global(.ansi-bg-magenta) { background-color: #c026d3; }
	:global(.ansi-bg-cyan) { background-color: #0891b2; }
	:global(.ansi-bg-white) { background-color: #d4d4d8; }

	/* Text styles */
	:global(.ansi-bold) { font-weight: bold; }
	:global(.ansi-dim) { opacity: 0.7; }
	:global(.ansi-italic) { font-style: italic; }
	:global(.ansi-underline) { text-decoration: underline; }
</style>
