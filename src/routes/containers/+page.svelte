<svelte:head>
	<title>Containers - Dockhand</title>
</svelte:head>

<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { toast } from 'svelte-sonner';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Popover from '$lib/components/ui/popover';
	import * as Select from '$lib/components/ui/select';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import MultiSelectFilter from '$lib/components/MultiSelectFilter.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch';
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import {
		Play,
		Square,
		RotateCw,
		Trash2,
		Plus,
		FileText,
		Pencil,
		RefreshCw,
		CircleArrowUp,
		X,
		Terminal,
		ArrowUpDown,
		ArrowUp,
		ArrowDown,
		Search,
		ExternalLink,
		LayoutPanelLeft,
		Rows3,
		GripVertical,
		Skull,
		Pause,
		Eye,
		Shell,
		User,
		CheckSquare,
		Square as SquareIcon,
		Check,
		XCircle,
		Icon,
		AlertTriangle,
		FolderOpen,
		ShieldOff,
		ShieldAlert,
		ShieldX,
		Shield,
		ShieldCheck,
		Box,
		Ship,
		Cable,
		Copy,
		Loader2,
		AlertCircle
	} from 'lucide-svelte';
	import { broom } from '@lucide/lab';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import CreateContainerModal from './CreateContainerModal.svelte';
	import EditContainerModal from './EditContainerModal.svelte';
	import TerminalPanel from '../terminal/TerminalPanel.svelte';
	import LogsPanel from '../logs/LogsPanel.svelte';
	import ContainerInspectModal from './ContainerInspectModal.svelte';
	import FileBrowserModal from './FileBrowserModal.svelte';
	import BatchUpdateModal from './BatchUpdateModal.svelte';
	import BatchOperationModal from '$lib/components/BatchOperationModal.svelte';
	import type { ContainerInfo, ContainerStats } from '$lib/types';
	import { EmptyState, NoEnvironment } from '$lib/components/ui/empty-state';
	import { currentEnvironment, environments, appendEnvParam, clearStaleEnvironment } from '$lib/stores/environment';
	import { onDockerEvent, isContainerListChange } from '$lib/stores/events';
	import { appSettings } from '$lib/stores/settings';
	import { canAccess } from '$lib/stores/auth';
	import { vulnerabilityCriteriaIcons } from '$lib/utils/update-steps';
	import { ipToNumber } from '$lib/utils/ip';
	import { formatHostPortUrl } from '$lib/utils/url';
	import { detectShells, getBestShell, hasAvailableShell, USER_OPTIONS, type ShellDetectionResult } from '$lib/utils/shell-detection';
	import { DataGrid } from '$lib/components/data-grid';
	import type { ColumnConfig } from '$lib/types';
	import type { DataGridRowState } from '$lib/components/data-grid/types';

	// Track previous stats for change detection
	let previousStats = $state<Map<string, ContainerStats>>(new Map());
	let changedFields = $state<Map<string, Set<string>>>(new Map());

	// Format bytes to human readable
	function formatBytes(bytes: number, decimals = 1): string {
		if (bytes === 0) return '0B';
		const k = 1024;
		const sizes = ['B', 'K', 'M', 'G', 'T'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + sizes[i];
	}

	type SortField = 'name' | 'image' | 'state' | 'health' | 'uptime' | 'stack' | 'ip' | 'cpu' | 'memory';
	type SortDirection = 'asc' | 'desc';

	let containers = $state<ContainerInfo[]>([]);
	let containerStats = $state<Map<string, ContainerStats>>(new Map());
	let autoUpdateSettings = $state<Map<string, { enabled: boolean; label: string; tooltip: string; vulnerabilityCriteria?: string }>>(new Map());
	let envId = $state<number | null>(null);
	let envHasScanning = $state(false);
	let envVulnerabilityCriteria = $state<'never' | 'any' | 'critical_high' | 'critical' | 'more_than_current'>('never');

	// Derived: current environment details for reactive port URL generation
	const currentEnvDetails = $derived($environments.find(e => e.id === $currentEnvironment?.id) ?? null);

	// Search and sort state
	let searchQuery = $state('');
	let sortField = $state<SortField>('name');
	let sortDirection = $state<SortDirection>('asc');

	// Status filter state
	const STATUS_FILTER_STORAGE_KEY = 'dockhand-containers-status-filter';
	let statusFilter = $state<string[]>([]);

	// Status types with icons for filter and table
	const statusTypes = [
		{ value: 'running', label: 'Running', icon: Play, color: 'text-emerald-500' },
		{ value: 'paused', label: 'Paused', icon: Pause, color: 'text-amber-500' },
		{ value: 'restarting', label: 'Restarting', icon: RotateCw, color: 'text-red-500' },
		{ value: 'exited', label: 'Exited', icon: Square, color: 'text-rose-500' },
		{ value: 'created', label: 'Created', icon: Plus, color: 'text-sky-500' },
		{ value: 'dead', label: 'Dead', icon: Skull, color: 'text-gray-500' }
	];

	function getStatusIcon(state: string) {
		const status = statusTypes.find(s => s.value === state.toLowerCase());
		return status?.icon || Square;
	}

	function getStatusIconColor(state: string): string {
		const status = statusTypes.find(s => s.value === state.toLowerCase());
		return status?.color || 'text-muted-foreground';
	}

	function loadStatusFilter() {
		if (typeof window !== 'undefined') {
			const saved = localStorage.getItem(STATUS_FILTER_STORAGE_KEY);
			if (saved) {
				try {
					statusFilter = JSON.parse(saved);
				} catch {
					statusFilter = [];
				}
			}
		}
	}

	function saveStatusFilter() {
		if (typeof window !== 'undefined') {
			localStorage.setItem(STATUS_FILTER_STORAGE_KEY, JSON.stringify(statusFilter));
		}
	}

	// Save status filter when it changes
	$effect(() => {
		const _s = statusFilter;
		saveStatusFilter();
	});

	// Track if initial fetch has been done
	let initialFetchDone = $state(false);

	// Subscribe to environment changes using $effect
	$effect(() => {
		const env = $currentEnvironment;
		const newEnvId = env?.id ?? null;

		// Only fetch if environment actually changed or this is initial load
		if (env && (newEnvId !== envId || !initialFetchDone)) {
			envId = newEnvId;
			initialFetchDone = true;
			// Clear update state from previous environment
			batchUpdateContainerIds = [];
			batchUpdateContainerNames = new Map();
			updateCheckStatus = 'idle';
			// Clear shell detection cache for new environment
			shellDetectionCache = {};
			fetchContainers();
			fetchStats();
			loadPendingUpdates();
		} else if (!env) {
			// No environment - clear data and stop loading
			envId = null;
			containers = [];
			loading = false;
			batchUpdateContainerIds = [];
			batchUpdateContainerNames = new Map();
			updateCheckStatus = 'idle';
			shellDetectionCache = {};
		}
	});
	let loading = $state(true);
	let showCreateModal = $state(false);
	let showEditModal = $state(false);
	let editContainerId = $state('');

	// Inspect modal state
	let showInspectModal = $state(false);
	let inspectContainerId = $state('');
	let inspectContainerName = $state('');

	// File browser modal state
	let showFileBrowserModal = $state(false);
	let fileBrowserContainerId = $state('');
	let fileBrowserContainerName = $state('');

	// Terminal state - track active terminals per container
	interface ActiveTerminal {
		containerId: string;
		containerName: string;
		shell: string;
		user: string;
	}
	let activeTerminals = $state<ActiveTerminal[]>([]);
	let currentTerminalContainerId = $state<string | null>(null);
	let terminalPopoverStates = $state<Record<string, boolean>>({});
	let terminalShell = $state('/bin/bash');
	let terminalUser = $state('root');

	// Confirmation popover state
	let confirmStopId = $state<string | null>(null);
	let confirmRestartId = $state<string | null>(null);
	let confirmDeleteId = $state<string | null>(null);

	// Bulk action confirmation state
	let confirmBulkStop = $state(false);
	let confirmBulkStart = $state(false);
	let confirmBulkRestart = $state(false);
	let confirmBulkPause = $state(false);
	let confirmBulkUnpause = $state(false);
	let confirmBulkRemove = $state(false);

	// Prune state
	let confirmPrune = $state(false);
	let pruneStatus = $state<'idle' | 'pruning' | 'success' | 'error'>('idle');

	// Update check state
	let updateCheckStatus = $state<'idle' | 'checking' | 'found' | 'none' | 'error'>('idle');
	let showBatchUpdateModal = $state(false);
	let batchUpdateContainerIds = $state<string[]>([]);
	let batchUpdateContainerNames = $state<Map<string, string>>(new Map());

	// Single container update mode (doesn't overwrite batch list)
	let singleUpdateContainerId = $state<string | null>(null);
	let singleUpdateContainerName = $state<string | null>(null);

	// Operation error state
	let operationError = $state<{ id: string; message: string } | null>(null);

	// Timeout tracking for cleanup
	let pendingTimeouts: ReturnType<typeof setTimeout>[] = [];

	function clearErrorAfterDelay(id: string) {
		pendingTimeouts.push(setTimeout(() => {
			if (operationError?.id === id) operationError = null;
		}, 5000));
	}

	// Multi-select state (for bulk actions via checkbox)
	let selectedContainers = $state<Set<string>>(new Set());
	let bulkActionInProgress = $state(false);

	// Row highlight state (visual only, for row click)
	let highlightedRowId = $state<string | null>(null);

	// Batch operation modal state
	let showBatchOpModal = $state(false);
	let batchOpTitle = $state('');
	let batchOpOperation = $state('');
	let batchOpItems = $state<Array<{ id: string; name: string }>>([]);
	let batchOpOptions = $state<Record<string, any>>({});

	// Set of container IDs with updates available (for O(1) lookup)
	const containersWithUpdatesSet = $derived(new Set(batchUpdateContainerIds));

	// Count of updatable containers (excluding system containers like Dockhand/Hawser)
	const updatableContainersCount = $derived(
		batchUpdateContainerIds.filter(id => {
			const container = containers.find(c => c.id === id);
			return container && !container.systemContainer;
		}).length
	);

	// Check if any selected container has an update available (excluding system containers)
	const selectedHaveUpdates = $derived(
		Array.from(selectedContainers).some(id => {
			const container = containers.find(c => c.id === id);
			return container && containersWithUpdatesSet.has(id) && !container.systemContainer;
		})
	);

	// Count selected containers with updates (excluding system containers)
	const selectedWithUpdatesCount = $derived(
		Array.from(selectedContainers).filter(id => {
			const container = containers.find(c => c.id === id);
			return container && containersWithUpdatesSet.has(id) && !container.systemContainer;
		}).length
	);

	// Selection helpers
	function selectNone() {
		selectedContainers = new Set();
	}

	// Bulk actions - now use BatchOperationModal
	function startBatchOperation(
		opTitle: string,
		operation: string,
		targetContainers: ContainerInfo[],
		options: Record<string, any> = {}
	) {
		batchOpTitle = opTitle;
		batchOpOperation = operation;
		batchOpItems = targetContainers.map(c => ({ id: c.id, name: c.name }));
		batchOpOptions = options;
		showBatchOpModal = true;
	}

	function handleBatchOpClose() {
		showBatchOpModal = false;
	}

	function handleBatchOpComplete() {
		selectedContainers = new Set();
		fetchContainers();
	}

	function bulkStart() {
		startBatchOperation(
			`Starting ${selectedStopped.length} container${selectedStopped.length !== 1 ? 's' : ''}`,
			'start',
			selectedStopped
		);
	}

	function bulkStop() {
		startBatchOperation(
			`Stopping ${selectedRunning.length} container${selectedRunning.length !== 1 ? 's' : ''}`,
			'stop',
			selectedRunning
		);
	}

	function bulkRestart() {
		startBatchOperation(
			`Restarting ${selectedInFilter.length} container${selectedInFilter.length !== 1 ? 's' : ''}`,
			'restart',
			selectedInFilter
		);
	}

	function bulkPause() {
		startBatchOperation(
			`Pausing ${selectedRunning.length} container${selectedRunning.length !== 1 ? 's' : ''}`,
			'pause',
			selectedRunning
		);
	}

	function bulkUnpause() {
		startBatchOperation(
			`Unpausing ${selectedPaused.length} container${selectedPaused.length !== 1 ? 's' : ''}`,
			'unpause',
			selectedPaused
		);
	}

	function bulkRemove() {
		startBatchOperation(
			`Removing ${selectedInFilter.length} container${selectedInFilter.length !== 1 ? 's' : ''}`,
			'remove',
			selectedInFilter,
			{ force: true }
		);
	}

	async function pruneContainers() {
		pruneStatus = 'pruning';
		confirmPrune = false;
		try {
			const response = await fetch(appendEnvParam('/api/prune/containers', envId), {
				method: 'POST'
			});
			if (response.ok) {
				pruneStatus = 'success';
				await fetchContainers();
			} else {
				pruneStatus = 'error';
			}
		} catch (error) {
			pruneStatus = 'error';
		}
		pendingTimeouts.push(setTimeout(() => {
			pruneStatus = 'idle';
		}, 3000));
	}

	async function checkForUpdates() {
		updateCheckStatus = 'checking';
		try {
			const response = await fetch(appendEnvParam('/api/containers/check-updates', envId), {
				method: 'POST'
			});
			if (!response.ok) {
				updateCheckStatus = 'error';
				pendingTimeouts.push(setTimeout(() => { updateCheckStatus = 'idle'; }, 3000));
				return;
			}
			const data = await response.json();
			const containersWithUpdates = data.results.filter((r: any) => r.hasUpdate);

			if (containersWithUpdates.length === 0) {
				updateCheckStatus = 'none';
				batchUpdateContainerIds = [];
				batchUpdateContainerNames.clear();
				toast.success('All containers are up to date');
				pendingTimeouts.push(setTimeout(() => { updateCheckStatus = 'idle'; }, 3000));
				return;
			}

			// Prepare data for batch update modal (but don't open it yet)
			batchUpdateContainerIds = containersWithUpdates.map((r: any) => r.containerId);
			batchUpdateContainerNames = new Map(
				containersWithUpdates.map((r: any) => [r.containerId, r.containerName])
			);
			updateCheckStatus = 'found';
			toast.info(`${containersWithUpdates.length} update(s) available`);
		} catch (error) {
			updateCheckStatus = 'error';
			pendingTimeouts.push(setTimeout(() => { updateCheckStatus = 'idle'; }, 3000));
		}
	}

	// Load pending updates from database (persisted from check-updates or scheduled jobs)
	async function loadPendingUpdates() {
		if (!envId) return;
		try {
			const response = await fetch(appendEnvParam('/api/containers/pending-updates', envId));
			if (!response.ok) return;
			const data = await response.json();
			if (data.pendingUpdates && data.pendingUpdates.length > 0) {
				batchUpdateContainerIds = data.pendingUpdates.map((u: any) => u.containerId);
				batchUpdateContainerNames = new Map(
					data.pendingUpdates.map((u: any) => [u.containerId, u.containerName])
				);
				updateCheckStatus = 'found';
			}
		} catch {
			// Ignore errors - this is a background load
		}
	}

	function updateSelectedContainers() {
		// Only include selected containers that have updates available (excluding system containers)
		const selectedWithUpdates = Array.from(selectedContainers).filter(id => {
			const container = containers.find(c => c.id === id);
			return container && containersWithUpdatesSet.has(id) && !container.systemContainer;
		});
		if (selectedWithUpdates.length === 0) return;

		const selectedNames = new Map<string, string>();
		for (const id of selectedWithUpdates) {
			const container = containers.find(c => c.id === id);
			if (container) {
				selectedNames.set(id, container.name);
			}
		}
		batchUpdateContainerIds = selectedWithUpdates;
		batchUpdateContainerNames = selectedNames;
		showBatchUpdateModal = true;
	}

	function updateAllContainers() {
		if (batchUpdateContainerIds.length === 0) return;

		// Build names map from all containers with updates (excluding system containers)
		const allNames = new Map<string, string>();
		for (const id of batchUpdateContainerIds) {
			const container = containers.find(c => c.id === id);
			if (container && !container.systemContainer) {
				allNames.set(id, container.name);
			}
		}
		if (allNames.size === 0) return;
		batchUpdateContainerNames = allNames;
		showBatchUpdateModal = true;
	}

	function updateSingleContainer(containerId: string, containerName: string) {
		// Use single-container mode to avoid overwriting the batch list
		singleUpdateContainerId = containerId;
		singleUpdateContainerName = containerName;
		showBatchUpdateModal = true;
	}

	function handleBatchUpdateClose() {
		showBatchUpdateModal = false;
		singleUpdateContainerId = null;
		singleUpdateContainerName = null;
		updateCheckStatus = 'idle';
	}

	function handleBatchUpdateComplete(results: { success: string[]; failed: string[]; blocked: string[] }) {
		if (results.success.length > 0) {
			toast.success(`Updated ${results.success.length} container(s)`);
		}
		if (results.failed.length > 0) {
			toast.error(`Failed to update ${results.failed.length} container(s)`);
		}
		if (results.blocked.length > 0) {
			toast.warning(`${results.blocked.length} update(s) blocked by vulnerability policy`);
		}
		selectedContainers = new Set();

		// Clear single-update mode
		singleUpdateContainerId = null;
		singleUpdateContainerName = null;

		// Reload pending updates from database to restore highlighting for remaining containers
		loadPendingUpdates();

		fetchContainers();
	}

	// Action in progress state (for animations)
	let stoppingId = $state<string | null>(null);
	let restartingId = $state<string | null>(null);

	// Helper to check if container has active terminal
	function hasActiveTerminal(containerId: string): boolean {
		return activeTerminals.some(t => t.containerId === containerId);
	}

	// Helper to get active terminal
	function getActiveTerminal(containerId: string): ActiveTerminal | undefined {
		return activeTerminals.find(t => t.containerId === containerId);
	}

	// Shell detection state per container
	let shellDetectionCache = $state<Record<string, ShellDetectionResult>>({});
	let detectingShellsFor = $state<string | null>(null);

	// Check if any shell is available for a container
	function anyShellAvailableFor(containerId: string): boolean {
		const detection = shellDetectionCache[containerId];
		return !detection || hasAvailableShell(detection);
	}

	// Detect shells when popover opens
	async function detectContainerShells(containerId: string) {
		if (shellDetectionCache[containerId] || detectingShellsFor === containerId) return;

		detectingShellsFor = containerId;
		try {
			const result = await detectShells(containerId, $currentEnvironment?.id ?? null);
			shellDetectionCache[containerId] = result;

			// Auto-select best available shell if current is not available
			const bestShell = getBestShell(result, terminalShell);
			if (bestShell && bestShell !== terminalShell) {
				terminalShell = bestShell;
			}
		} catch (error) {
			console.error('Failed to detect shells:', error);
		} finally {
			detectingShellsFor = null;
		}
	}

	// User options from shared utilities
	const userOptions = USER_OPTIONS;

	// Stats polling interval - module scope for cleanup in onDestroy
	let statsInterval: ReturnType<typeof setInterval> | null = null;
	let unsubscribeDockerEvent: (() => void) | null = null;

	// Logs state - track active logs per container (like terminals)
	interface ActiveLogs {
		containerId: string;
		containerName: string;
	}
	let activeLogs = $state<ActiveLogs[]>([]);
	let currentLogsContainerId = $state<string | null>(null);

	// Helper to check if container has active logs
	function hasActiveLogs(containerId: string): boolean {
		return activeLogs.some(l => l.containerId === containerId);
	}

	// Helper to get active logs
	function getActiveLogs(containerId: string): ActiveLogs | undefined {
		return activeLogs.find(l => l.containerId === containerId);
	}

	// Layout state - horizontal (panels at bottom) or vertical (panels on right)
	type LayoutMode = 'horizontal' | 'vertical';
	const LAYOUT_STORAGE_KEY = 'dockhand-containers-layout';
	const PANEL_WIDTH_STORAGE_KEY = 'dockhand-containers-panel-width';
	const DEFAULT_PANEL_WIDTH = 400;
	const MIN_PANEL_WIDTH = 250;
	const MAX_PANEL_WIDTH = 800;

	let layoutMode = $state<LayoutMode>('horizontal');
	let panelWidth = $state(DEFAULT_PANEL_WIDTH);
	let isResizingWidth = $state(false);
	let mainContentRef: HTMLDivElement | undefined;

	function loadLayoutMode() {
		if (typeof window !== 'undefined') {
			const saved = localStorage.getItem(LAYOUT_STORAGE_KEY) as LayoutMode;
			if (saved === 'horizontal' || saved === 'vertical') {
				layoutMode = saved;
			}
			const savedWidth = localStorage.getItem(PANEL_WIDTH_STORAGE_KEY);
			if (savedWidth) {
				const w = parseInt(savedWidth);
				if (!isNaN(w) && w >= MIN_PANEL_WIDTH && w <= MAX_PANEL_WIDTH) {
					panelWidth = w;
				}
			}
		}
	}

	function toggleLayoutMode() {
		layoutMode = layoutMode === 'horizontal' ? 'vertical' : 'horizontal';
		if (typeof window !== 'undefined') {
			localStorage.setItem(LAYOUT_STORAGE_KEY, layoutMode);
		}
	}

	function startWidthResize(e: MouseEvent) {
		e.preventDefault();
		isResizingWidth = true;
		document.addEventListener('mousemove', handleWidthResize);
		document.addEventListener('mouseup', stopWidthResize);
	}

	function handleWidthResize(e: MouseEvent) {
		if (!isResizingWidth || !mainContentRef) return;
		const containerRect = mainContentRef.getBoundingClientRect();
		const newWidth = containerRect.right - e.clientX;
		panelWidth = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, newWidth));
	}

	function stopWidthResize() {
		isResizingWidth = false;
		document.removeEventListener('mousemove', handleWidthResize);
		document.removeEventListener('mouseup', stopWidthResize);
		if (typeof window !== 'undefined') {
			localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(panelWidth));
		}
	}

	let scrollContainer: HTMLDivElement | undefined;

	// Filtered and sorted containers - use $derived.by for complex logic
	const filteredContainers = $derived.by(() => {
		let result = containers;

		// Filter out stopped/exited containers if setting is disabled
		if (!$appSettings.showStoppedContainers) {
			result = result.filter(c => c.state.toLowerCase() !== 'exited');
		}

		// Filter by status if any are selected
		if (statusFilter.length > 0) {
			result = result.filter(c => statusFilter.includes(c.state.toLowerCase()));
		}

		// Filter by search query
		if (searchQuery.trim()) {
			const query = searchQuery.toLowerCase();
			result = result.filter(c =>
				c.name.toLowerCase().includes(query) ||
				c.image.toLowerCase().includes(query) ||
				(c.labels?.['com.docker.compose.project'] || '').toLowerCase().includes(query)
			);
		}

		// Sort
		result = [...result].sort((a, b) => {
			let cmp = 0;
			switch (sortField) {
				case 'name':
					cmp = a.name.localeCompare(b.name);
					break;
				case 'image':
					cmp = a.image.localeCompare(b.image);
					break;
				case 'state':
					// Running first, then others alphabetically
					const stateOrder = { running: 0, paused: 1, created: 2, exited: 3 };
					cmp = (stateOrder[a.state.toLowerCase() as keyof typeof stateOrder] ?? 4) -
						  (stateOrder[b.state.toLowerCase() as keyof typeof stateOrder] ?? 4);
					break;
				case 'health':
					const healthOrder: Record<string, number> = { unhealthy: 0, starting: 1, healthy: 2 };
					const healthA = a.health ? (healthOrder[a.health] ?? 1) : 3;
					const healthB = b.health ? (healthOrder[b.health] ?? 1) : 3;
					cmp = healthA - healthB;
					break;
				case 'uptime':
					cmp = parseUptimeToSeconds(a.status) - parseUptimeToSeconds(b.status);
					break;
				case 'stack':
					const stackA = a.labels?.['com.docker.compose.project'] || '';
					const stackB = b.labels?.['com.docker.compose.project'] || '';
					cmp = stackA.localeCompare(stackB);
					break;
				case 'ip':
					const ipA = getContainerIp(a.networks);
					const ipB = getContainerIp(b.networks);
					cmp = ipToNumber(ipA) - ipToNumber(ipB);
					break;
				case 'cpu':
					const cpuA = containerStats.get(a.id)?.cpuPercent ?? -1;
					const cpuB = containerStats.get(b.id)?.cpuPercent ?? -1;
					cmp = cpuA - cpuB;
					break;
				case 'memory':
					const memA = containerStats.get(a.id)?.memoryUsage ?? -1;
					const memB = containerStats.get(b.id)?.memoryUsage ?? -1;
					cmp = memA - memB;
					break;
			}
			// Secondary sort by name for stability when primary values are equal
			if (cmp === 0 && sortField !== 'name') {
				cmp = a.name.localeCompare(b.name);
			}
			return sortDirection === 'asc' ? cmp : -cmp;
		});

		return result;
	});

	// Check if all filtered containers are selected
	const allFilteredSelected = $derived(
		filteredContainers.length > 0 && filteredContainers.every(c => selectedContainers.has(c.id))
	);

	// Check if some (but not all) filtered containers are selected
	const someFilteredSelected = $derived(
		filteredContainers.some(c => selectedContainers.has(c.id)) && !allFilteredSelected
	);

	// Get selected containers that are in current filter
	const selectedInFilter = $derived(
		filteredContainers.filter(c => selectedContainers.has(c.id))
	);

	// Count by state for selected containers
	const selectedRunning = $derived(selectedInFilter.filter(c => c.state === 'running'));
	const selectedStopped = $derived(selectedInFilter.filter(c => c.state !== 'running' && c.state !== 'paused'));
	const selectedPaused = $derived(selectedInFilter.filter(c => c.state === 'paused'));

	async function fetchContainers() {
		loading = true;
		try {
			const response = await fetch(appendEnvParam('/api/containers', envId));
			if (!response.ok) {
				// Handle stale environment ID (e.g., after database reset)
				if (response.status === 404 && envId) {
					clearStaleEnvironment(envId);
					environments.refresh();
					return;
				}
				toast.error('Failed to load containers');
				return;
			}
			containers = await response.json();
			// Fetch auto-update settings for all containers
			await fetchAutoUpdateSettings();
		} catch (error) {
			console.error('Failed to fetch containers:', error);
			toast.error('Failed to load containers');
		} finally {
			loading = false;
		}
	}

	async function checkScannerSettings() {
		if (!envId) {
			envHasScanning = false;
			envVulnerabilityCriteria = 'never';
			return;
		}
		try {
			// Fetch scanner settings and environment update-check settings in parallel
			const [scannerResponse, updateCheckResponse] = await Promise.all([
				fetch(`/api/settings/scanner?env=${envId}&settingsOnly=true`),
				fetch(`/api/environments/${envId}/update-check`)
			]);

			if (scannerResponse.ok) {
				const data = await scannerResponse.json();
				const settings = data.settings || data;
				envHasScanning = settings.scanner !== 'none';
			}

			if (updateCheckResponse.ok) {
				const data = await updateCheckResponse.json();
				envVulnerabilityCriteria = data.settings?.vulnerabilityCriteria || 'never';
			}
		} catch {
			envHasScanning = false;
			envVulnerabilityCriteria = 'never';
		}
	}

	async function fetchAutoUpdateSettings() {
		const settings = new Map<string, { enabled: boolean; label: string; tooltip: string; vulnerabilityCriteria?: string }>();
		const envParam = envId ? `?env=${envId}` : '';

		// Check scanner settings first
		await checkScannerSettings();

		// Fetch all auto-update settings in a single request
		try {
			const response = await fetch(`/api/auto-update${envParam}`);
			if (response.ok) {
				const data = await response.json();
				// data is a map of containerName -> settings
				for (const [containerName, setting] of Object.entries(data)) {
					if (setting && typeof setting === 'object' && 'enabled' in setting && setting.enabled) {
						const s = setting as { enabled: boolean; scheduleType: string; cronExpression: string | null; vulnerabilityCriteria: string };
						const { label, tooltip } = formatSchedule(s.scheduleType, s.cronExpression || '');
						settings.set(containerName, {
							enabled: true,
							label,
							tooltip,
							vulnerabilityCriteria: s.vulnerabilityCriteria || 'never'
						});
					}
				}
			}
		} catch (err) {
			console.error('Failed to fetch auto-update settings:', err);
		}

		autoUpdateSettings = settings;
	}

	function formatSchedule(scheduleType: string, cronExpression: string): { label: string; tooltip: string } {
		if (!cronExpression) return { label: 'on', tooltip: 'Auto-update enabled' };

		const parts = cronExpression.split(' ');
		if (parts.length < 5) return { label: 'cron', tooltip: cronExpression };

		const [min, hr, , , dow] = parts;
		const hourNum = parseInt(hr);
		const minNum = parseInt(min);
		const ampm = hourNum >= 12 ? 'PM' : 'AM';
		const hour12 = hourNum === 0 ? 12 : hourNum > 12 ? hourNum - 12 : hourNum;
		const timeStr = `${hour12}:${minNum.toString().padStart(2, '0')} ${ampm}`;

		if (scheduleType === 'daily' || dow === '*') {
			return { label: 'daily', tooltip: `Daily at ${timeStr}` };
		}

		if (scheduleType === 'weekly') {
			const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
			const dayName = days[parseInt(dow)] || dow;
			return { label: dayName, tooltip: `Every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][parseInt(dow)] || dow} at ${timeStr}` };
		}

		return { label: 'cron', tooltip: cronExpression };
	}

	// Check if highlightChanges is enabled for current environment
	const highlightChangesEnabled = $derived($currentEnvironment?.highlightChanges ?? true);

	// Helper to check if a stat field changed significantly
	function hasFieldChanged(containerId: string, field: string, oldVal: number | undefined, newVal: number | undefined): boolean {
		if (oldVal === undefined || newVal === undefined) return false;
		// For CPU, consider significant if changed by more than 0.5%
		if (field === 'cpu') return Math.abs(newVal - oldVal) > 0.5;
		// For memory, consider significant if changed by more than 1MB
		if (field === 'memory') return Math.abs(newVal - oldVal) > 1024 * 1024;
		// For network/disk, consider significant if changed by more than 10KB
		return Math.abs(newVal - oldVal) > 10 * 1024;
	}

	// Helper to check if a field is currently highlighted
	function isFieldHighlighted(containerId: string, field: string): boolean {
		if (!highlightChangesEnabled) return false;
		return changedFields.get(containerId)?.has(field) ?? false;
	}

	async function fetchStats() {
		try {
			const response = await fetch(appendEnvParam('/api/containers/stats', envId));
			const stats: ContainerStats[] = await response.json();
			const statsMap = new Map<string, ContainerStats>();
			const newChangedFields = new Map<string, Set<string>>();

			for (const stat of stats) {
				statsMap.set(stat.id, stat);

				// Track changes if highlighting is enabled
				if (highlightChangesEnabled) {
					const prev = previousStats.get(stat.id);
					if (prev) {
						const changes = new Set<string>();
						if (hasFieldChanged(stat.id, 'cpu', prev.cpuPercent, stat.cpuPercent)) changes.add('cpu');
						if (hasFieldChanged(stat.id, 'memory', prev.memoryUsage, stat.memoryUsage)) changes.add('memory');
						if (hasFieldChanged(stat.id, 'networkRx', prev.networkRx, stat.networkRx)) changes.add('network');
						if (hasFieldChanged(stat.id, 'networkTx', prev.networkTx, stat.networkTx)) changes.add('network');
						if (hasFieldChanged(stat.id, 'blockRead', prev.blockRead, stat.blockRead)) changes.add('disk');
						if (hasFieldChanged(stat.id, 'blockWrite', prev.blockWrite, stat.blockWrite)) changes.add('disk');
						if (changes.size > 0) {
							newChangedFields.set(stat.id, changes);
						}
					}
				}
			}

			// Update changed fields and clear after animation duration
			changedFields = newChangedFields;
			if (newChangedFields.size > 0) {
				pendingTimeouts.push(setTimeout(() => {
					changedFields = new Map();
				}, 1500));
			}

			// Store current stats as previous for next comparison
			previousStats = new Map(statsMap);
			containerStats = statsMap;
		} catch (error) {
			console.error('Failed to fetch container stats:', error);
		}
	}

	async function startContainer(id: string) {
		operationError = null;
		const container = containers.find(c => c.id === id);
		const name = container?.name || id.slice(0, 12);
		try {
			const response = await fetch(appendEnvParam(`/api/containers/${id}/start`, envId), { method: 'POST' });
			if (!response.ok) {
				const data = await response.json();
				operationError = { id, message: data.error || 'Failed to start container' };
				toast.error(`Failed to start ${name}`);
				clearErrorAfterDelay(id);
				return;
			}
			toast.success(`Started ${name}`);
			await fetchContainers();
		} catch (error) {
			console.error('Failed to start container:', error);
			operationError = { id, message: 'Failed to start container' };
			toast.error(`Failed to start ${name}`);
			clearErrorAfterDelay(id);
		}
	}

	async function stopContainer(id: string) {
		operationError = null;
		stoppingId = id;
		const container = containers.find(c => c.id === id);
		const name = container?.name || id.slice(0, 12);
		try {
			const response = await fetch(appendEnvParam(`/api/containers/${id}/stop`, envId), { method: 'POST' });
			if (!response.ok) {
				const data = await response.json();
				operationError = { id, message: data.error || 'Failed to stop container' };
				toast.error(`Failed to stop ${name}`);
				clearErrorAfterDelay(id);
				return;
			}
			toast.success(`Stopped ${name}`);
			await fetchContainers();
		} catch (error) {
			console.error('Failed to stop container:', error);
			operationError = { id, message: 'Failed to stop container' };
			toast.error(`Failed to stop ${name}`);
			clearErrorAfterDelay(id);
		} finally {
			stoppingId = null;
		}
	}

	async function pauseContainer(id: string) {
		operationError = null;
		const container = containers.find(c => c.id === id);
		const name = container?.name || id.slice(0, 12);
		try {
			const response = await fetch(appendEnvParam(`/api/containers/${id}/pause`, envId), { method: 'POST' });
			if (!response.ok) {
				const data = await response.json();
				operationError = { id, message: data.error || 'Failed to pause container' };
				toast.error(`Failed to pause ${name}`);
				clearErrorAfterDelay(id);
				return;
			}
			toast.success(`Paused ${name}`);
			await fetchContainers();
		} catch (error) {
			console.error('Failed to pause container:', error);
			operationError = { id, message: 'Failed to pause container' };
			toast.error(`Failed to pause ${name}`);
			clearErrorAfterDelay(id);
		}
	}

	async function unpauseContainer(id: string) {
		operationError = null;
		const container = containers.find(c => c.id === id);
		const name = container?.name || id.slice(0, 12);
		try {
			const response = await fetch(appendEnvParam(`/api/containers/${id}/unpause`, envId), { method: 'POST' });
			if (!response.ok) {
				const data = await response.json();
				operationError = { id, message: data.error || 'Failed to unpause container' };
				toast.error(`Failed to unpause ${name}`);
				clearErrorAfterDelay(id);
				return;
			}
			toast.success(`Resumed ${name}`);
			await fetchContainers();
		} catch (error) {
			console.error('Failed to unpause container:', error);
			operationError = { id, message: 'Failed to unpause container' };
			toast.error(`Failed to unpause ${name}`);
			clearErrorAfterDelay(id);
		}
	}

	async function restartContainer(id: string) {
		operationError = null;
		restartingId = id;
		const container = containers.find(c => c.id === id);
		const name = container?.name || id.slice(0, 12);
		try {
			const response = await fetch(appendEnvParam(`/api/containers/${id}/restart`, envId), { method: 'POST' });
			if (!response.ok) {
				const data = await response.json();
				operationError = { id, message: data.error || 'Failed to restart container' };
				toast.error(`Failed to restart ${name}`);
				clearErrorAfterDelay(id);
				return;
			}
			toast.success(`Restarted ${name}`);
			await fetchContainers();
		} catch (error) {
			console.error('Failed to restart container:', error);
			operationError = { id, message: 'Failed to restart container' };
			toast.error(`Failed to restart ${name}`);
			clearErrorAfterDelay(id);
		} finally {
			restartingId = null;
		}
	}

	async function removeContainer(id: string) {
		operationError = null;
		const container = containers.find(c => c.id === id);
		const name = container?.name || id.slice(0, 12);
		try {
			const response = await fetch(appendEnvParam(`/api/containers/${id}?force=true`, envId), { method: 'DELETE' });
			if (!response.ok) {
				const data = await response.json();
				operationError = { id, message: data.error || 'Failed to remove container' };
				toast.error(`Failed to remove ${name}`);
				clearErrorAfterDelay(id);
				return;
			}
			toast.success(`Removed ${name}`);
			await fetchContainers();
		} catch (error) {
			console.error('Failed to remove container:', error);
			operationError = { id, message: 'Failed to remove container' };
			toast.error(`Failed to remove ${name}`);
			clearErrorAfterDelay(id);
		}
	}

	function openTerminal(container: ContainerInfo) {
		// Check if there's already an active terminal for this container
		const existingTerminal = getActiveTerminal(container.id);
		if (existingTerminal) {
			// Just show the existing terminal
			currentTerminalContainerId = container.id;
			terminalPopoverStates[container.id] = false;
		} else {
			// Show popover to configure new terminal
			terminalPopoverStates[container.id] = true;
		}
	}

	function startTerminal(container: ContainerInfo) {
		// Create new terminal session
		const terminal: ActiveTerminal = {
			containerId: container.id,
			containerName: container.name,
			shell: terminalShell,
			user: terminalUser
		};
		activeTerminals = [...activeTerminals, terminal];
		currentTerminalContainerId = container.id;
		terminalPopoverStates[container.id] = false;
	}

	function closeTerminal(containerId: string) {
		activeTerminals = activeTerminals.filter(t => t.containerId !== containerId);
		if (currentTerminalContainerId === containerId) {
			currentTerminalContainerId = null;
		}
	}

	function showLogs(container: ContainerInfo) {
		// Check if there's already active logs for this container
		if (hasActiveLogs(container.id)) {
			// Just show the existing logs
			currentLogsContainerId = container.id;
		} else {
			// Create new logs session
			const logs: ActiveLogs = {
				containerId: container.id,
				containerName: container.name
			};
			activeLogs = [...activeLogs, logs];
			currentLogsContainerId = container.id;
		}
	}

	function closeLogs(containerId: string) {
		activeLogs = activeLogs.filter(l => l.containerId !== containerId);
		if (currentLogsContainerId === containerId) {
			currentLogsContainerId = null;
		}
	}

	function selectContainer(container: ContainerInfo) {
		// Handle logs - show if container has active logs, hide otherwise
		if (hasActiveLogs(container.id)) {
			currentLogsContainerId = container.id;
		} else if (currentLogsContainerId) {
			// Hide current logs but keep the session active
			currentLogsContainerId = null;
		}

		// Handle terminal - show if container has active terminal, hide otherwise
		if (hasActiveTerminal(container.id)) {
			currentTerminalContainerId = container.id;
		} else if (currentTerminalContainerId) {
			// Hide current terminal but keep the session active
			currentTerminalContainerId = null;
		}
	}

	function editContainer(id: string) {
		editContainerId = id;
		showEditModal = true;
	}

	function inspectContainer(container: ContainerInfo) {
		inspectContainerId = container.id;
		inspectContainerName = container.name;
		showInspectModal = true;
	}

	function browseFiles(container: ContainerInfo) {
		fileBrowserContainerId = container.id;
		fileBrowserContainerName = container.name;
		showFileBrowserModal = true;
	}

	function getStatusClasses(state: string): string {
		const base = 'state-badge px-1.5 py-0.5 rounded-sm text-xs font-medium text-black dark:text-white shadow-sm whitespace-nowrap justify-center';
		switch (state.toLowerCase()) {
			case 'running':
				return `${base} bg-emerald-200 dark:bg-emerald-800`;
			case 'exited':
				return `${base} bg-rose-200 dark:bg-rose-800`;
			case 'restarting':
				return `${base} bg-red-300 dark:bg-red-700`;
			case 'paused':
				return `${base} bg-amber-200 dark:bg-amber-800`;
			case 'created':
				return `${base} bg-sky-200 dark:bg-sky-800`;
			default:
				return `${base} bg-slate-200 dark:bg-slate-700`;
		}
	}

	interface PortMapping {
		publicPort: number;
		privatePort: number;
		display: string;
	}

	function formatPorts(ports: ContainerInfo['ports']): PortMapping[] {
		if (!ports || ports.length === 0) return [];
		const seen = new Set<string>();
		return ports
			.filter(p => p.PublicPort)
			.map(p => ({
				publicPort: p.PublicPort,
				privatePort: p.PrivatePort,
				display: `${p.PublicPort}:${p.PrivatePort}`
			}))
			.filter(p => {
				const key = p.display;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
	}

	function extractHostFromUrl(urlString: string): string | null {
		if (!urlString) return null;

		// Handle tcp://, http://, https:// URLs
		const protocolMatch = urlString.match(/^(?:tcp|http|https):\/\/([^:/]+)/i);
		if (protocolMatch) {
			return protocolMatch[1];
		}

		// Handle hostname:port format (no protocol)
		const hostPortMatch = urlString.match(/^([^:/]+):\d+$/);
		if (hostPortMatch) {
			return hostPortMatch[1];
		}

		// Just a hostname
		return urlString;
	}

	function getPortUrl(publicPort: number): string | null {
		const env = currentEnvDetails;
		if (!env) return null;

		// Priority 1: Use publicIp if configured
		if (env.publicIp) {
			return formatHostPortUrl(env.publicIp, publicPort);
		}

		// Priority 2: Extract from host for direct/hawser-standard
		const connectionType = env.connectionType || 'socket';

		if (connectionType === 'direct' && env.host) {
			// Remote Docker via TCP - extract host from URL (e.g., tcp://192.168.1.4:2376)
			const host = extractHostFromUrl(env.host);
			if (host) return formatHostPortUrl(host, publicPort);
		} else if (connectionType === 'hawser-standard' && env.host) {
			// Hawser standard mode - extract host from URL
			const host = extractHostFromUrl(env.host);
			if (host) return formatHostPortUrl(host, publicPort);
		}

		// No public IP available for socket or hawser-edge
		return null;
	}

	function getContainerIp(networks: ContainerInfo['networks']): string {
		if (!networks) return '-';
		const entries = Object.entries(networks);
		if (entries.length === 0) return '-';
		const ip = entries[0][1]?.ipAddress;
		return ip || '-';
	}

	function formatUptime(status: string): string {
		// Extract uptime from status like "Up 2 hours" or "Exited (0) 3 days ago"
		if (!status) return '-';
		const upMatch = status.match(/Up\s+(.+?)(?:\s+\(|$)/i);
		if (upMatch) return upMatch[1].trim();
		const exitMatch = status.match(/Exited.+?(\d+\s+\w+)\s+ago/i);
		if (exitMatch) return exitMatch[1] + ' ago';
		return '-';
	}

	let copiedCommand = $state<string | null>(null);
	let copyFailed = $state(false);

	async function copyCommand(text: string) {
		const ok = await copyToClipboard(text);
		if (ok) {
			copiedCommand = text;
			toast.success('Copied to clipboard');
			setTimeout(() => { copiedCommand = null; }, 2000);
		} else {
			copyFailed = true;
			setTimeout(() => { copyFailed = false; }, 2000);
		}
	}

	function parseUptimeToSeconds(status: string): number {
		// Parse uptime from status to seconds for sorting
		// Running containers have positive values (higher = longer uptime)
		// Stopped containers have negative values (sorted after running)
		if (!status) return -Infinity;

		const upMatch = status.match(/Up\s+(.+?)(?:\s+\(|$)/i);
		if (upMatch) {
			return parseTimeStringToSeconds(upMatch[1].trim());
		}

		// Exited containers - use negative values so they sort after running
		const exitMatch = status.match(/Exited.+?(\d+\s+\w+)\s+ago/i);
		if (exitMatch) {
			return -parseTimeStringToSeconds(exitMatch[1]);
		}

		return -Infinity;
	}

	function parseTimeStringToSeconds(timeStr: string): number {
		// Parse strings like "2 hours", "3 days", "About a minute", "Less than a second"
		const str = timeStr.toLowerCase();

		if (str.includes('second')) return 1;
		if (str.includes('less than a minute') || str.includes('about a minute')) return 60;

		const match = str.match(/(\d+)\s*(second|minute|hour|day|week|month|year)/);
		if (!match) return 0;

		const value = parseInt(match[1], 10);
		const unit = match[2];

		switch (unit) {
			case 'second': return value;
			case 'minute': return value * 60;
			case 'hour': return value * 3600;
			case 'day': return value * 86400;
			case 'week': return value * 604800;
			case 'month': return value * 2592000;
			case 'year': return value * 31536000;
			default: return 0;
		}
	}

	function getHealthVariant(health?: string): 'default' | 'destructive' | 'secondary' | 'outline' {
		switch (health) {
			case 'healthy':
				return 'default';
			case 'unhealthy':
				return 'destructive';
			case 'starting':
				return 'secondary';
			default:
				return 'outline';
		}
	}

	function formatMounts(mounts: ContainerInfo['mounts']): string[] {
		if (!mounts || mounts.length === 0) return [];
		return mounts.map(m => {
			const src = m.source.length > 20 ? '...' + m.source.slice(-17) : m.source;
			return `${src}:${m.destination}`;
		});
	}

	function getComposeProject(labels: ContainerInfo['labels']): string | null {
		return labels?.['com.docker.compose.project'] || null;
	}

	function toggleSort(field: SortField) {
		if (sortField === field) {
			sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
		} else {
			sortField = field;
			sortDirection = field === 'state' ? 'asc' : 'asc';
		}
	}


	// Handle tab visibility changes (e.g., user switches back from another tab)
	function handleVisibilityChange() {
		if (document.visibilityState === 'visible' && envId) {
			// Tab became visible - refresh data immediately
			fetchContainers();
			fetchStats();
		}
	}

	onMount(async () => {
		loadLayoutMode();
		loadStatusFilter();

		// Check for image filter from URL params (from images page link)
		const imageParam = $page.url.searchParams.get('image');
		if (imageParam) {
			searchQuery = imageParam;
		}

		// Load persisted pending updates from database
		loadPendingUpdates();

		// Listen for tab visibility changes to refresh when user returns
		document.addEventListener('visibilitychange', handleVisibilityChange);
		document.addEventListener('resume', handleVisibilityChange);

		// Initial fetch is handled by $effect - no need to duplicate here

		// Set up interval to refresh stats every 5 seconds (use module-scope var for cleanup)
		statsInterval = setInterval(() => {
			if (envId) fetchStats();
		}, 5000);

		// Subscribe to container events (SSE connection is global in layout)
		unsubscribeDockerEvent = onDockerEvent((event) => {
			if (envId && isContainerListChange(event)) {
				fetchContainers();
				fetchStats();
			}
		});

		// Note: In Svelte 5, cleanup must be in onDestroy, not returned from onMount
	});

	// Cleanup on component destroy
	onDestroy(() => {
		// Clear stats polling interval
		if (statsInterval) {
			clearInterval(statsInterval);
			statsInterval = null;
		}

		// Unsubscribe from Docker events
		if (unsubscribeDockerEvent) {
			unsubscribeDockerEvent();
			unsubscribeDockerEvent = null;
		}

		// Cleanup resize event listeners and pending timeouts
		document.removeEventListener('mousemove', handleWidthResize);
		document.removeEventListener('mouseup', stopWidthResize);
		document.removeEventListener('visibilitychange', handleVisibilityChange);
		document.removeEventListener('resume', handleVisibilityChange);
		pendingTimeouts.forEach(id => clearTimeout(id));
		pendingTimeouts = [];
	});
</script>

<div class="flex-1 min-h-0 flex flex-col gap-3 overflow-hidden">
	<div class="shrink-0 flex flex-wrap justify-between items-center gap-3 min-h-8">
		<PageHeader icon={Box} title="Containers" count={containers.length} />
		<div class="flex flex-wrap items-center gap-2">
			<div class="relative">
				<Search class="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
				<Input
					type="text"
					placeholder="Search containers..."
					bind:value={searchQuery}
					onkeydown={(e) => e.key === 'Escape' && (searchQuery = '')}
					class="pl-8 h-8 w-48 text-sm"
				/>
			</div>
			<!-- Status filter (multi-select) -->
			<MultiSelectFilter
				bind:value={statusFilter}
				options={statusTypes}
				placeholder="All statuses"
				pluralLabel="statuses"
				width="w-44"
				defaultIcon={Box}
			/>
			<div class="flex gap-2">
				{#if $canAccess('containers', 'create')}
				<Button size="sm" variant="secondary" onclick={() => (showCreateModal = true)}>
					<Plus class="w-3.5 h-3.5" />
					Create
				</Button>
				{/if}
				<Button
					size="sm"
					variant="outline"
					onclick={checkForUpdates}
					disabled={updateCheckStatus === 'checking'}
					title="Check for available updates"
				>
					{#if updateCheckStatus === 'checking'}
						<CircleArrowUp class="w-3.5 h-3.5 mr-1 animate-spin" />
					{:else if updateCheckStatus === 'none' || updateCheckStatus === 'found'}
						<Check class="w-3.5 h-3.5 mr-1 text-green-600" />
					{:else if updateCheckStatus === 'error'}
						<XCircle class="w-3.5 h-3.5 mr-1 text-destructive" />
					{:else}
						<CircleArrowUp class="w-3.5 h-3.5" />
					{/if}
					Check for updates
				</Button>
				{#if updatableContainersCount > 0}
				<Button
					size="sm"
					variant="outline"
					onclick={updateAllContainers}
					class="border-amber-500/40 text-amber-600 hover:bg-amber-500/10 hover:border-amber-500"
					title="Update all containers with available updates"
				>
					<CircleArrowUp class="w-3.5 h-3.5" />
					Update all ({updatableContainersCount})
				</Button>
				{/if}
				{#if $canAccess('containers', 'remove')}
				<ConfirmPopover
					open={confirmPrune}
					action="Prune"
					itemType="stopped containers"
					title="Prune containers"
					position="left"
					onConfirm={pruneContainers}
					onOpenChange={(open) => confirmPrune = open}
					unstyled
				>
					{#snippet children({ open })}
						<Button size="sm" variant="outline" disabled={pruneStatus === 'pruning'}>
							{#if pruneStatus === 'pruning'}
								<RefreshCw class="w-3.5 h-3.5 mr-1 animate-spin" />
							{:else if pruneStatus === 'success'}
								<Check class="w-3.5 h-3.5 mr-1 text-green-600" />
							{:else if pruneStatus === 'error'}
								<XCircle class="w-3.5 h-3.5 mr-1 text-destructive" />
							{:else}
								<Icon iconNode={broom} class="w-3.5 h-3.5" />
							{/if}
							Prune
						</Button>
					{/snippet}
				</ConfirmPopover>
				{/if}
				<Button size="sm" variant="outline" onclick={fetchContainers}>Refresh</Button>
				<Button
					size="sm"
					variant="outline"
					onclick={toggleLayoutMode}
					class="h-8 w-8 p-0"
					title={layoutMode === 'horizontal' ? 'Switch to vertical layout (logs/terminal on side)' : 'Switch to horizontal layout (logs/terminal below)'}
				>
					{#if layoutMode === 'horizontal'}
						<LayoutPanelLeft class="w-4 h-4" />
					{:else}
						<Rows3 class="w-4 h-4" />
					{/if}
				</Button>
			</div>
		</div>
	</div>

	<!-- Selection bar - always reserve space to prevent layout shift -->
	<div class="h-4 shrink-0">
		{#if selectedContainers.size > 0}
			<div class="flex items-center gap-1 text-xs text-muted-foreground h-full">
			<span>{selectedInFilter.length} selected</span>
			<button
				type="button"
				class="inline-flex items-center gap-1 px-1.5 py-0 rounded border border-border hover:border-foreground/30 hover:shadow transition-all"
				onclick={selectNone}
				disabled={bulkActionInProgress}
			>
				Clear
			</button>
			{#if selectedStopped.length > 0 && $canAccess('containers', 'start')}
				<ConfirmPopover
					open={confirmBulkStart}
					action="Start"
					itemType="{selectedStopped.length} stopped container{selectedStopped.length !== 1 ? 's' : ''}"
					title="Start {selectedStopped.length}"
					variant="secondary"
					unstyled
					onConfirm={bulkStart}
					onOpenChange={(open) => confirmBulkStart = open}
				>
					{#snippet children({ open })}
						<span class="inline-flex items-center gap-1 px-1.5 py-0 rounded border border-border hover:text-green-600 hover:border-green-500/40 hover:shadow transition-all cursor-pointer {bulkActionInProgress ? 'opacity-50' : ''}">
							<Play class="w-3 h-3" />
							Start
						</span>
					{/snippet}
				</ConfirmPopover>
			{/if}
			{#if selectedRunning.length > 0 && $canAccess('containers', 'stop')}
				<ConfirmPopover
					open={confirmBulkStop}
					action="Stop"
					itemType="{selectedRunning.length} running container{selectedRunning.length !== 1 ? 's' : ''}"
					title="Stop {selectedRunning.length}"
					unstyled
					onConfirm={bulkStop}
					onOpenChange={(open) => confirmBulkStop = open}
				>
					{#snippet children({ open })}
						<span class="inline-flex items-center gap-1 px-1.5 py-0 rounded border border-border hover:text-red-600 hover:border-red-500/40 hover:shadow transition-all cursor-pointer {bulkActionInProgress ? 'opacity-50' : ''}">
							<Square class="w-3 h-3" />
							Stop
						</span>
					{/snippet}
				</ConfirmPopover>
				<ConfirmPopover
					open={confirmBulkPause}
					action="Pause"
					itemType="{selectedRunning.length} running container{selectedRunning.length !== 1 ? 's' : ''}"
					title="Pause {selectedRunning.length}"
					variant="secondary"
					unstyled
					onConfirm={bulkPause}
					onOpenChange={(open) => confirmBulkPause = open}
				>
					{#snippet children({ open })}
						<span class="inline-flex items-center gap-1 px-1.5 py-0 rounded border border-border hover:text-yellow-600 hover:border-yellow-500/40 hover:shadow transition-all cursor-pointer {bulkActionInProgress ? 'opacity-50' : ''}">
							<Pause class="w-3 h-3" />
							Pause
						</span>
					{/snippet}
				</ConfirmPopover>
			{/if}
			{#if selectedPaused.length > 0 && $canAccess('containers', 'start')}
				<ConfirmPopover
					open={confirmBulkUnpause}
					action="Unpause"
					itemType="{selectedPaused.length} paused container{selectedPaused.length !== 1 ? 's' : ''}"
					title="Unpause {selectedPaused.length}"
					variant="secondary"
					unstyled
					onConfirm={bulkUnpause}
					onOpenChange={(open) => confirmBulkUnpause = open}
				>
					{#snippet children({ open })}
						<span class="inline-flex items-center gap-1 px-1.5 py-0 rounded border border-border hover:text-blue-600 hover:border-blue-500/40 hover:shadow transition-all cursor-pointer {bulkActionInProgress ? 'opacity-50' : ''}">
							<Play class="w-3 h-3" />
							Unpause
						</span>
					{/snippet}
				</ConfirmPopover>
			{/if}
			{#if $canAccess('containers', 'restart')}
			<ConfirmPopover
				open={confirmBulkRestart}
				action="Restart"
				itemType="{selectedInFilter.length} container{selectedInFilter.length !== 1 ? 's' : ''}"
				title="Restart {selectedInFilter.length}"
				variant="secondary"
				unstyled
				onConfirm={bulkRestart}
				onOpenChange={(open) => confirmBulkRestart = open}
			>
				{#snippet children({ open })}
					<span class="inline-flex items-center gap-1 px-1.5 py-0 rounded border border-border hover:border-foreground/30 hover:shadow transition-all cursor-pointer {bulkActionInProgress ? 'opacity-50' : ''}">
						<RotateCw class="w-3 h-3" />
						Restart
					</span>
				{/snippet}
			</ConfirmPopover>
			{/if}
			{#if $canAccess('containers', 'remove')}
			<ConfirmPopover
				open={confirmBulkRemove}
				action="Remove"
				itemType="{selectedInFilter.length} container{selectedInFilter.length !== 1 ? 's' : ''}"
				title="Remove {selectedInFilter.length}"
				unstyled
				onConfirm={bulkRemove}
				onOpenChange={(open) => confirmBulkRemove = open}
			>
				{#snippet children({ open })}
					<span class="inline-flex items-center gap-1 px-1.5 py-0 rounded border border-border hover:text-destructive hover:border-destructive/40 hover:shadow transition-all cursor-pointer {bulkActionInProgress ? 'opacity-50' : ''}">
						<Trash2 class="w-3 h-3" />
						Remove
					</span>
				{/snippet}
			</ConfirmPopover>
			{/if}
			{#if selectedHaveUpdates}
			<button
				type="button"
				class="inline-flex items-center gap-1 px-1.5 py-0 rounded border border-amber-500/40 text-amber-600 hover:border-amber-500 hover:shadow transition-all cursor-pointer {bulkActionInProgress ? 'opacity-50' : ''}"
				onclick={updateSelectedContainers}
				disabled={bulkActionInProgress}
				title="Update selected containers to latest image"
			>
				<CircleArrowUp class="w-3 h-3" />
				Update {selectedWithUpdatesCount}
			</button>
			{/if}
			{#if bulkActionInProgress}
				<CircleArrowUp class="w-3 h-3 animate-spin ml-1" />
			{/if}
			</div>
		{/if}
	</div>

	{#if !loading && ($environments.length === 0 || !$currentEnvironment)}
		<NoEnvironment />
	{:else if !loading && containers.length === 0}
		<EmptyState
			icon={Box}
			title="No containers found"
			description="Create a new container to get started"
		/>
	{:else}
		<!-- Main content area - changes based on layout mode -->
		<div
			bind:this={mainContentRef}
			class="flex-1 min-h-0 {layoutMode === 'vertical' ? 'flex gap-3' : 'flex flex-col gap-3'}"
		>
<!-- Table section -->
			<DataGrid
				data={filteredContainers}
				keyField="id"
				gridId="containers"
				loading={loading}
				selectable
				bind:selectedKeys={selectedContainers}
				sortState={{ field: sortField, direction: sortDirection }}
				onSortChange={(state) => { sortField = state.field as SortField; sortDirection = state.direction; }}
				highlightedKey={highlightedRowId}
				rowClass={(container) => {
					let classes = '';
					if (currentLogsContainerId === container.id) classes += 'bg-blue-500/10 hover:bg-blue-500/15 ';
					if (currentTerminalContainerId === container.id) classes += 'bg-green-500/10 hover:bg-green-500/15 ';
					if ($appSettings.highlightUpdates && containersWithUpdatesSet.has(container.id)) classes += 'has-update ';
					return classes;
				}}
				onRowClick={(container, e) => {
					if (activeLogs.length > 0 || activeTerminals.length > 0) {
						selectContainer(container);
					}
					highlightedRowId = highlightedRowId === container.id ? null : container.id;
				}}
			>
				{#snippet cell(column, container, rowState)}
					{@const ports = formatPorts(container.ports)}
					{@const stack = getComposeProject(container.labels)}
					{#if column.id === 'name'}
						<div class="flex items-center gap-1.5 min-w-0">
							<button
								type="button"
								class="text-xs font-medium truncate text-left hover:text-primary hover:underline cursor-pointer"
								title={container.name}
								onclick={(e) => { e.stopPropagation(); inspectContainer(container); }}
							>{container.name}</button>
							{#if container.systemContainer}
								{@const hasUpdate = containersWithUpdatesSet.has(container.id)}
								<Tooltip.Root>
									<Tooltip.Trigger>
										<Badge variant="secondary" class="text-2xs py-0 px-1 shrink-0 {hasUpdate ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20' : 'bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20'} cursor-help flex items-center gap-0.5">
											{#if container.systemContainer === 'dockhand'}
												<Ship class="w-2.5 h-2.5" />
											{:else}
												<Cable class="w-2.5 h-2.5" />
											{/if}
											{container.systemContainer === 'dockhand' ? 'Dockhand' : 'Hawser'}
											{#if hasUpdate}
												<CircleArrowUp class="w-2.5 h-2.5" />
											{/if}
										</Badge>
									</Tooltip.Trigger>
									<Tooltip.Content side="right" class="w-auto p-3">
										{#if container.systemContainer === 'dockhand'}
											{#if hasUpdate}
												<div class="space-y-2">
													<p class="font-medium text-sm flex items-center gap-1.5">
														<CircleArrowUp class="w-4 h-4 text-amber-500" />
														Update available
													</p>
													<p class="text-muted-foreground text-xs">Update Dockhand from the About page:</p>
													<a
														href="/settings?tab=about"
														class="text-primary hover:underline text-xs flex items-center gap-1"
														onclick={(e) => e.stopPropagation()}
													>
														Settings &gt; About &gt; Update now
													</a>
												</div>
											{:else}
												<p class="text-sm whitespace-nowrap">Dockhand management container</p>
											{/if}
										{:else}
											{#if hasUpdate}
												<div class="space-y-2">
													<p class="font-medium text-sm flex items-center gap-1.5 whitespace-nowrap">
														<CircleArrowUp class="w-4 h-4 text-amber-500" />
														Update available
													</p>
													<p class="text-muted-foreground text-xs whitespace-nowrap">Update on the remote host where Hawser runs.</p>
													<a
														href="https://github.com/Finsys/hawser"
														target="_blank"
														rel="noopener noreferrer"
														class="text-primary hover:underline text-xs flex items-center gap-1 whitespace-nowrap"
														onclick={(e) => e.stopPropagation()}
													>
														<ExternalLink class="w-3 h-3" />
														Update instructions on GitHub
													</a>
												</div>
											{:else}
												<p class="text-sm whitespace-nowrap">Hawser remote agent</p>
											{/if}
										{/if}
									</Tooltip.Content>
								</Tooltip.Root>
							{/if}
						</div>
					{:else if column.id === 'image'}
						<div class="flex items-center gap-1.5 {$appSettings.highlightUpdates && containersWithUpdatesSet.has(container.id) ? 'update-border' : ''}">
							{#if containersWithUpdatesSet.has(container.id)}
								<span title="Update available">
									<CircleArrowUp class="w-3 h-3 text-amber-500 {$appSettings.highlightUpdates ? 'glow-amber' : ''} shrink-0" />
								</span>
							{/if}
							<span class="text-xs text-muted-foreground truncate" title={container.image}>{container.image}</span>
						</div>
					{:else if column.id === 'state'}
						{@const StateIcon = getStatusIcon(container.state)}
						<span class="{getStatusClasses(container.state)} inline-flex items-center gap-1">
							<StateIcon class="w-[1em] h-[1em] {container.state.toLowerCase() === 'restarting' ? 'animate-spin' : ''}" />
							{container.state}
						</span>
					{:else if column.id === 'health'}
						{#if container.health}
							<div class="flex items-center justify-center" title={container.health}>
								{#if container.health === 'healthy'}
									<span class="h-2.5 w-2.5 rounded-full bg-green-500 animate-pulse"></span>
								{:else if container.health === 'unhealthy'}
									<span class="h-2.5 w-2.5 rounded-full bg-red-500"></span>
								{:else}
									<span class="h-2.5 w-2.5 rounded-full bg-yellow-500 animate-pulse"></span>
								{/if}
							</div>
						{:else}
							<div class="flex items-center justify-center">
								<span class="text-gray-400 dark:text-gray-600 text-xs">-</span>
							</div>
						{/if}
					{:else if column.id === 'uptime'}
						<span class="text-xs text-muted-foreground whitespace-nowrap">{formatUptime(container.status)}</span>
					{:else if column.id === 'restartCount'}
						{#if container.restartCount > 0}
							<span class="text-xs text-red-500 text-center block" title="{container.restartCount} restarts">{container.restartCount}</span>
						{:else}
							<span class="text-gray-400 dark:text-gray-600 text-xs text-center block">-</span>
						{/if}
					{:else if column.id === 'cpu'}
						<div class="{isFieldHighlighted(container.id, 'cpu') ? 'stat-highlight' : ''} text-right">
							{#if containerStats.get(container.id)}
								{@const stats = containerStats.get(container.id)}
								<span class="text-xs font-mono {stats.cpuPercent > 80 ? 'text-red-500' : stats.cpuPercent > 50 ? 'text-yellow-500' : 'text-muted-foreground'}">{stats.cpuPercent.toFixed(1)}%</span>
							{:else if container.state === 'running'}
								<span class="text-xs text-muted-foreground/50">...</span>
							{:else}
								<span class="text-gray-400 dark:text-gray-600 text-xs">-</span>
							{/if}
						</div>
					{:else if column.id === 'memory'}
						<div class="{isFieldHighlighted(container.id, 'memory') ? 'stat-highlight' : ''} text-right">
							{#if containerStats.get(container.id)}
								{@const stats = containerStats.get(container.id)}
								{@const memoryTooltip = stats.memoryCache > 0
									? `${formatBytes(stats.memoryUsage)} / ${formatBytes(stats.memoryLimit)} (Total: ${formatBytes(stats.memoryRaw)} | Cache: ${formatBytes(stats.memoryCache)})`
									: `${formatBytes(stats.memoryUsage)} / ${formatBytes(stats.memoryLimit)}`}
								<span class="text-xs font-mono {stats.memoryPercent > 80 ? 'text-red-500' : stats.memoryPercent > 50 ? 'text-yellow-500' : 'text-muted-foreground'}" title={memoryTooltip}>{formatBytes(stats.memoryUsage)}</span>
							{:else if container.state === 'running'}
								<span class="text-xs text-muted-foreground/50">...</span>
							{:else}
								<span class="text-gray-400 dark:text-gray-600 text-xs">-</span>
							{/if}
						</div>
					{:else if column.id === 'networkIO'}
						<div class="{isFieldHighlighted(container.id, 'network') ? 'stat-highlight' : ''} text-right whitespace-nowrap">
							{#if containerStats.get(container.id)}
								{@const stats = containerStats.get(container.id)}
								<span class="text-xs font-mono text-muted-foreground" title="↓{formatBytes(stats.networkRx)} received / ↑{formatBytes(stats.networkTx)} sent">
									<span class="text-2xs text-blue-400">↓</span>{formatBytes(stats.networkRx, 0)} <span class="text-2xs text-orange-400">↑</span>{formatBytes(stats.networkTx, 0)}
								</span>
							{:else if container.state === 'running'}
								<span class="text-xs text-muted-foreground/50">...</span>
							{:else}
								<span class="text-gray-400 dark:text-gray-600 text-xs">-</span>
							{/if}
						</div>
					{:else if column.id === 'diskIO'}
						<div class="{isFieldHighlighted(container.id, 'disk') ? 'stat-highlight' : ''} text-right whitespace-nowrap">
							{#if containerStats.get(container.id)}
								{@const stats = containerStats.get(container.id)}
								<span class="text-xs font-mono text-muted-foreground" title="↓{formatBytes(stats.blockRead)} read / ↑{formatBytes(stats.blockWrite)} written">
									<span class="text-2xs text-green-400">r</span>{formatBytes(stats.blockRead, 0)} <span class="text-2xs text-yellow-400">w</span>{formatBytes(stats.blockWrite, 0)}
								</span>
							{:else if container.state === 'running'}
								<span class="text-xs text-muted-foreground/50">...</span>
							{:else}
								<span class="text-gray-400 dark:text-gray-600 text-xs">-</span>
							{/if}
						</div>
					{:else if column.id === 'ip'}
						<code class="text-xs">{getContainerIp(container.networks)}</code>
					{:else if column.id === 'ports'}
						{#if ports.length > 0}
							<div class="flex flex-wrap gap-1">
								{#each ports.slice(0, 2) as port}
									{@const url = currentEnvDetails ? getPortUrl(port.publicPort) : null}
									{#if url}
										<a
											href={url}
											target="_blank"
											rel="noopener noreferrer"
											onclick={(e) => e.stopPropagation()}
											class="inline-flex items-center gap-0.5 text-xs bg-muted hover:bg-blue-500/20 hover:text-blue-500 px-1 py-0.5 rounded transition-colors"
											title="Open {url} in new tab"
										>
											<code>{port.display}</code>
											<ExternalLink class="w-2.5 h-2.5 text-muted-foreground" />
										</a>
									{:else}
										<code class="text-xs bg-muted px-1 py-0.5 rounded">{port.display}</code>
									{/if}
								{/each}
								{#if ports.length > 2}
									<span class="text-xs text-muted-foreground">+{ports.length - 2}</span>
								{/if}
							</div>
						{:else}
							<span class="text-gray-400 dark:text-gray-600 text-xs">-</span>
						{/if}
					{:else if column.id === 'autoUpdate'}
						{#if autoUpdateSettings.get(container.name)?.enabled}
							{@const settings = autoUpdateSettings.get(container.name)}
							<div class="flex items-center justify-center gap-1">
								<span class="text-xs text-green-500 cursor-default" title={settings?.tooltip}>{settings?.label}</span>
								{#if envHasScanning}
									{@const criteria = settings?.vulnerabilityCriteria || 'never'}
									{@const icon = vulnerabilityCriteriaIcons[criteria]}
									{#if icon}
										{@const IconComponent = icon.component}
										<span class="cursor-default" title={icon.title}>
											<IconComponent class={icon.class} />
										</span>
									{/if}
								{/if}
							</div>
						{:else}
							<span class="text-gray-400 dark:text-gray-600 text-xs text-center block">-</span>
						{/if}
					{:else if column.id === 'stack'}
						{#if stack}
							<button
								type="button"
								onclick={(e) => { e.stopPropagation(); goto(appendEnvParam(`/stacks?search=${encodeURIComponent(stack)}`, envId)); }}
								class="cursor-pointer"
							>
								<Badge variant="outline" class="text-xs py-0 px-1.5 hover:bg-primary/10 hover:border-primary/50 transition-colors">{stack}</Badge>
							</button>
						{:else}
							<span class="text-gray-400 dark:text-gray-600 text-xs">-</span>
						{/if}
					{:else if column.id === 'actions'}
						<div class="relative flex gap-0.5 justify-end">
							{#if containersWithUpdatesSet.has(container.id) && !container.systemContainer}
								<button
									type="button"
									onclick={() => updateSingleContainer(container.id, container.name)}
									title="Update available - click to update"
									class="p-0.5 rounded hover:bg-muted transition-colors cursor-pointer"
								>
									<CircleArrowUp class="w-3 h-3 text-amber-500 {$appSettings.highlightUpdates ? 'glow-amber' : ''}" />
								</button>
							{/if}
							{#if container.state === 'running' || container.state === 'restarting'}
								{#if $canAccess('containers', 'stop')}
								<ConfirmPopover
									open={confirmStopId === container.id}
									action="Stop"
									itemType="container"
									itemName={container.name}
									title="Stop"
									onConfirm={() => stopContainer(container.id)}
									onOpenChange={(open) => confirmStopId = open ? container.id : null}
								>
									{#snippet children({ open })}
										<Square class="w-3 h-3 {open ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'} {stoppingId === container.id ? 'animate-pulse text-destructive' : ''}" />
									{/snippet}
								</ConfirmPopover>
								{#if container.state === 'running'}
								<button
									type="button"
									onclick={() => pauseContainer(container.id)}
									title="Pause"
									class="p-0.5 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
								>
									<Pause class="w-3 h-3 text-muted-foreground hover:text-yellow-500" />
								</button>
								{/if}
								{/if}
							{:else if container.state === 'paused'}
								{#if $canAccess('containers', 'start')}
								<button
									type="button"
									onclick={() => unpauseContainer(container.id)}
									title="Unpause"
									class="p-0.5 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
								>
									<Play class="w-3 h-3 text-muted-foreground hover:text-green-500" />
								</button>
								{/if}
							{:else}
								{#if $canAccess('containers', 'start')}
								<button
									type="button"
									onclick={() => startContainer(container.id)}
									title="Start"
									class="p-0.5 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
								>
									<Play class="w-3 h-3 text-muted-foreground hover:text-green-500" />
								</button>
								{/if}
							{/if}
							{#if $canAccess('containers', 'restart')}
							<ConfirmPopover
								open={confirmRestartId === container.id}
								action="Restart"
								itemType="container"
								itemName={container.name}
								title="Restart"
								variant="secondary"
								onConfirm={() => restartContainer(container.id)}
								onOpenChange={(open) => confirmRestartId = open ? container.id : null}
							>
								{#snippet children({ open })}
									<RotateCw class="w-3 h-3 {open ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'} {restartingId === container.id ? 'animate-spin text-foreground' : ''}" />
								{/snippet}
							</ConfirmPopover>
							{/if}
							<button
								type="button"
								onclick={() => inspectContainer(container)}
								title="View details"
								class="p-0.5 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
							>
								<Eye class="w-3 h-3 text-muted-foreground hover:text-foreground" />
							</button>
							{#if container.state === 'running' && $canAccess('containers', 'exec')}
							<button
								type="button"
								onclick={() => browseFiles(container)}
								title="Browse files"
								class="p-0.5 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
							>
								<FolderOpen class="w-3 h-3 text-muted-foreground hover:text-foreground" />
							</button>
							{/if}
							{#if $canAccess('containers', 'create')}
							<button
								type="button"
								onclick={() => editContainer(container.id)}
								title="Edit"
								class="p-0.5 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
							>
								<Pencil class="w-3 h-3 text-muted-foreground hover:text-foreground" />
							</button>
							{/if}
							{#if $canAccess('containers', 'logs')}
							{#if hasActiveLogs(container.id)}
								<button
									type="button"
									onclick={(e) => { e.stopPropagation(); currentLogsContainerId = container.id; }}
									title="Show logs"
									class="p-0.5 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
								>
									<FileText class="w-4 h-4 text-blue-400" style="filter: drop-shadow(0 0 4px rgba(96,165,250,0.9)) drop-shadow(0 0 8px rgba(96,165,250,0.6));" strokeWidth={2.5} />
								</button>
							{:else}
								<button
									type="button"
									onclick={(e) => { e.stopPropagation(); showLogs(container); }}
									title="Open logs"
									class="p-0.5 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
								>
									<FileText class="w-3 h-3 text-muted-foreground hover:text-foreground" />
								</button>
							{/if}
							{/if}
							{#if container.state === 'running' && $canAccess('containers', 'exec')}
							{#if hasActiveTerminal(container.id)}
								<button
									type="button"
									onclick={(e) => { e.stopPropagation(); currentTerminalContainerId = container.id; }}
									title="Show terminal"
									class="p-0.5 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
								>
									<Terminal class="w-4 h-4 text-green-400" style="filter: drop-shadow(0 0 4px rgba(74,222,128,0.9)) drop-shadow(0 0 8px rgba(74,222,128,0.6));" strokeWidth={2.5} />
								</button>
							{:else}
								<Popover.Root open={terminalPopoverStates[container.id] ?? false} onOpenChange={(open) => {
									terminalPopoverStates[container.id] = open;
									if (open) detectContainerShells(container.id);
								}}>
									<Popover.Trigger
										onclick={(e: MouseEvent) => e.stopPropagation()}
										class="p-0.5 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
									>
										<Terminal class="w-3 h-3 text-muted-foreground hover:text-foreground" />
									</Popover.Trigger>
									<Popover.Content class="w-56 p-0" align="end" sideOffset={5}>
										<div class="px-3 py-2 border-b bg-muted/50">
											<div class="flex items-center gap-2">
												<Terminal class="w-3.5 h-3.5 text-muted-foreground" />
												<span class="text-xs font-medium truncate" title={container.name}>{container.name}</span>
											</div>
										</div>
										{#if detectingShellsFor === container.id}
											<div class="p-4 text-center">
												<Loader2 class="w-5 h-5 mx-auto mb-2 text-muted-foreground animate-spin" />
												<p class="text-xs text-muted-foreground">Detecting shells...</p>
											</div>
										{:else if !anyShellAvailableFor(container.id)}
											<div class="p-4 text-center">
												<AlertCircle class="w-5 h-5 mx-auto mb-2 text-amber-500" />
												<p class="text-xs font-medium text-amber-500">No shell available</p>
												<p class="text-xs text-muted-foreground mt-1">This container has no shell installed.</p>
											</div>
										{:else}
											<div class="p-3 space-y-3">
												<div class="space-y-1.5">
													<Label class="text-xs">Shell</Label>
													<Select.Root type="single" bind:value={terminalShell}>
														<Select.Trigger class="w-full h-8 text-xs">
															<Shell class="w-3 h-3 mr-1.5 text-muted-foreground" />
															<span>{shellDetectionCache[container.id]?.allShells.find(o => o.path === terminalShell)?.label || 'Select'}</span>
														</Select.Trigger>
														<Select.Content>
															{#if shellDetectionCache[container.id]}
																{#each shellDetectionCache[container.id].allShells as option}
																	<Select.Item value={option.path} label={option.label} disabled={!option.available}>
																		<Shell class="w-3 h-3 mr-1.5 {option.available ? 'text-green-500' : 'text-muted-foreground/40'}" />
																		<span class={option.available ? 'text-foreground' : 'text-muted-foreground/60'}>
																			{option.label}
																			{#if !option.available}
																				<span class="text-xs ml-1">(unavailable)</span>
																			{/if}
																		</span>
																	</Select.Item>
																{/each}
															{/if}
														</Select.Content>
													</Select.Root>
												</div>
												<div class="space-y-1.5">
													<Label class="text-xs">User</Label>
													<Select.Root type="single" bind:value={terminalUser}>
														<Select.Trigger class="w-full h-8 text-xs">
															<User class="w-3 h-3 mr-1.5 text-muted-foreground" />
															<span>{userOptions.find(o => o.value === terminalUser)?.label || 'Select'}</span>
														</Select.Trigger>
														<Select.Content>
															{#each userOptions as option}
																<Select.Item value={option.value} label={option.label}>
																	<User class="w-3 h-3 mr-1.5 text-muted-foreground" />
																	{option.label}
																</Select.Item>
															{/each}
														</Select.Content>
													</Select.Root>
												</div>
												<Button size="sm" class="w-full h-7 text-xs" onclick={() => startTerminal(container)}>
													<Terminal class="w-3 h-3" />
													Connect
												</Button>
											</div>
										{/if}
									</Popover.Content>
								</Popover.Root>
							{/if}
							{/if}
							{#if $canAccess('containers', 'remove')}
							<ConfirmPopover
								open={confirmDeleteId === container.id}
								action="Delete"
								itemType="container"
								itemName={container.name}
								title="Remove"
								onConfirm={() => removeContainer(container.id)}
								onOpenChange={(open) => confirmDeleteId = open ? container.id : null}
							>
								{#snippet children({ open })}
									<Trash2 class="w-3 h-3 {open ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}" />
								{/snippet}
							</ConfirmPopover>
							{/if}
							{#if operationError?.id === container.id}
								<div class="absolute bottom-full right-0 mb-1 z-50 bg-destructive text-destructive-foreground rounded-md shadow-lg p-2 text-xs whitespace-nowrap flex items-center gap-2 max-w-xs">
									<AlertTriangle class="w-3 h-3 flex-shrink-0" />
									<span class="truncate">{operationError.message}</span>
									<button onclick={() => operationError = null} class="flex-shrink-0 hover:bg-white/20 rounded p-0.5">
										<X class="w-3 h-3" />
									</button>
								</div>
							{/if}
						</div>
					{/if}
				{/snippet}
			</DataGrid>

			<!-- Panels section - in vertical mode this is a column on the right with resize handle -->
			{#if layoutMode === 'vertical' && (currentLogsContainerId || currentTerminalContainerId)}
				<!-- Vertical resize handle -->
				<div
					role="separator"
					aria-orientation="vertical"
					class="w-2 cursor-ew-resize flex items-center justify-center hover:bg-muted transition-colors {isResizingWidth ? 'bg-muted' : ''}"
					onmousedown={startWidthResize}
				>
					<GripVertical class="w-4 h-8 text-zinc-600" />
				</div>

				<div class="flex flex-col gap-3 h-full overflow-hidden" style="width: {panelWidth}px; flex-shrink: 0;">
					<!-- Current Logs Panel -->
					{#if currentLogsContainerId}
						{@const activeLog = activeLogs.find(l => l.containerId === currentLogsContainerId)}
						{#if activeLog}
							<div class="flex-1 min-h-0">
								<LogsPanel
									containerId={activeLog.containerId}
									containerName={activeLog.containerName}
									visible={true}
									envId={envId}
									fillHeight={true}
									onClose={() => closeLogs(activeLog.containerId)}
								/>
							</div>
						{/if}
					{/if}

					<!-- Current Terminal Panel -->
					{#if currentTerminalContainerId}
						{@const activeTerminal = activeTerminals.find(t => t.containerId === currentTerminalContainerId)}
						{#if activeTerminal}
							<div class="flex-1 min-h-0">
								<TerminalPanel
									containerId={activeTerminal.containerId}
									containerName={activeTerminal.containerName}
									shell={activeTerminal.shell}
									user={activeTerminal.user}
									visible={true}
									envId={envId}
									fillHeight={true}
									onClose={() => closeTerminal(activeTerminal.containerId)}
								/>
							</div>
						{/if}
					{/if}
				</div>
			{/if}
		</div>

		<!-- Panels for horizontal mode - below the table, full width -->
		{#if layoutMode === 'horizontal'}
			<!-- Show current logs panel -->
			{#if currentLogsContainerId}
				{@const activeLog = activeLogs.find(l => l.containerId === currentLogsContainerId)}
				{#if activeLog}
					<LogsPanel
						containerId={activeLog.containerId}
						containerName={activeLog.containerName}
						visible={true}
						envId={envId}
						onClose={() => closeLogs(activeLog.containerId)}
					/>
				{/if}
			{/if}

			<!-- Show current terminal panel -->
			{#if currentTerminalContainerId}
				{@const activeTerminal = activeTerminals.find(t => t.containerId === currentTerminalContainerId)}
				{#if activeTerminal}
					<TerminalPanel
						containerId={activeTerminal.containerId}
						containerName={activeTerminal.containerName}
						shell={activeTerminal.shell}
						user={activeTerminal.user}
						visible={true}
						envId={envId}
						onClose={() => closeTerminal(activeTerminal.containerId)}
					/>
				{/if}
			{/if}
		{/if}
	{/if}
</div>

<CreateContainerModal
	bind:open={showCreateModal}
	onClose={() => (showCreateModal = false)}
	onSuccess={fetchContainers}
/>

<EditContainerModal
	bind:open={showEditModal}
	containerId={editContainerId}
	onClose={() => (showEditModal = false)}
	onSuccess={fetchContainers}
/>

<ContainerInspectModal
	bind:open={showInspectModal}
	containerId={inspectContainerId}
	containerName={inspectContainerName}
	onRename={(newName) => {
		// Update the container name in the local state
		inspectContainerName = newName;
		// Refresh the container list
		fetchContainers();
	}}
/>

<FileBrowserModal
	bind:open={showFileBrowserModal}
	containerId={fileBrowserContainerId}
	containerName={fileBrowserContainerName}
	envId={envId ?? undefined}
	onclose={() => showFileBrowserModal = false}
/>

<BatchUpdateModal
	bind:open={showBatchUpdateModal}
	containerIds={singleUpdateContainerId ? [singleUpdateContainerId] : batchUpdateContainerIds}
	containerNames={singleUpdateContainerId && singleUpdateContainerName ? new Map([[singleUpdateContainerId, singleUpdateContainerName]]) : batchUpdateContainerNames}
	{envId}
	vulnerabilityCriteria={envHasScanning ? envVulnerabilityCriteria : 'never'}
	onClose={handleBatchUpdateClose}
	onComplete={handleBatchUpdateComplete}
/>

<BatchOperationModal
	bind:open={showBatchOpModal}
	title={batchOpTitle}
	operation={batchOpOperation}
	entityType="containers"
	items={batchOpItems}
	envId={envId ?? undefined}
	options={batchOpOptions}
	onClose={handleBatchOpClose}
	onComplete={handleBatchOpComplete}
/>

<style>
	@keyframes amber-glow {
		0% {
			background-color: rgb(245 158 11 / 0.3);
			box-shadow: inset 0 0 8px rgb(245 158 11 / 0.5);
		}
		100% {
			background-color: transparent;
			box-shadow: none;
		}
	}

	:global(.stat-highlight) {
		animation: amber-glow 1.5s ease-out;
		border-radius: 2px;
	}

	/* Update available row styling */
	:global(tr.has-update) {
		background-color: rgb(245 158 11 / 0.15) !important;
	}

	:global(tr.has-update:hover) {
		background-color: rgb(245 158 11 / 0.25) !important;
	}

	:global(.update-border) {
		position: relative;
		margin: -4px -8px -4px -8px;
		padding: 4px 8px 4px 8px;
		border: 2px solid rgb(245 158 11);
		border-radius: 4px;
		box-shadow: 0 0 8px rgb(245 158 11 / 0.4);
	}

</style>

