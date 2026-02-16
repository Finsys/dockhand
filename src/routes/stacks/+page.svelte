<svelte:head>
	<title>Stacks - Dockhand</title>
</svelte:head>

<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { toast } from 'svelte-sonner';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import MultiSelectFilter from '$lib/components/MultiSelectFilter.svelte';
	import { Play, Square, Trash2, Plus, ArrowBigDown, Search, Pencil, ExternalLink, GitBranch, RefreshCw, Loader2, FileCode, Box, RotateCcw, ScrollText, Terminal, Eye, Network, HardDrive, Heart, HeartPulse, HeartOff, ChevronsUpDown, ChevronsDownUp, Rocket, AlertTriangle, X, Layers, Pause, CircleDashed, Skull, FolderOpen, Variable, Clock, RotateCw, Import } from 'lucide-svelte';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import BatchOperationModal from '$lib/components/BatchOperationModal.svelte';
	import type { ComposeStackInfo, ContainerStats } from '$lib/types';
	import StackModal from './StackModal.svelte';
	import GitStackModal from './GitStackModal.svelte';
	import ImportStackModal from './ImportStackModal.svelte';
	import GitDeployProgressPopover from './GitDeployProgressPopover.svelte';
	import ContainerInspectModal from '../containers/ContainerInspectModal.svelte';
	import FileBrowserModal from '../containers/FileBrowserModal.svelte';
	import { currentEnvironment, environments, appendEnvParam, clearStaleEnvironment } from '$lib/stores/environment';
	import { onDockerEvent, isContainerListChange } from '$lib/stores/events';
	import { canAccess } from '$lib/stores/auth';
	import { EmptyState, NoEnvironment } from '$lib/components/ui/empty-state';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { DataGrid } from '$lib/components/data-grid';
	import type { DataGridSortState } from '$lib/components/data-grid/types';
	import { ErrorDialog } from '$lib/components/ui/error-dialog';
	import { formatHostPortUrl } from '$lib/utils/url';

	type SortField = 'name' | 'containers' | 'status' | 'cpu' | 'memory';
	type SortDirection = 'asc' | 'desc';

	let stacks = $state<ComposeStackInfo[]>([]);
	let stackSources = $state<Record<string, { sourceType: string; composePath?: string | null; repository?: any; gitStack?: any }>>({});
	let stackEnvVarCounts = $state<Record<string, number>>({});
	let gitStacks = $state<any[]>([]);
	let gitRepositories = $state<any[]>([]);
	let gitCredentials = $state<any[]>([]);
	let containerStats = $state<Map<string, ContainerStats>>(new Map());
	let containerStatsHistory = $state<Map<string, { cpu: number[]; mem: number[]; netRx: number[]; netTx: number[]; diskR: number[]; diskW: number[] }>>(new Map());
	let statsUpdateCount = $state(0); // Force reactivity counter
	const MAX_HISTORY = 20;
	let loading = $state(true);
	let showCreateModal = $state(false);
	let showEditModal = $state(false);
	let showGitModal = $state(false);
	let showImportModal = $state(false);
	let editingStackName = $state('');
	let editingGitStack = $state<any>(null);
	let envId = $state<number | null>(null);

	// Derived: current environment details for reactive port URL generation
	const currentEnvDetails = $derived($environments.find(e => e.id === $currentEnvironment?.id) ?? null);

	// Polling intervals - module scope for cleanup in onDestroy
	let stacksInterval: ReturnType<typeof setInterval> | null = null;
	let statsInterval: ReturnType<typeof setInterval> | null = null;
	let unsubscribeDockerEvent: (() => void) | null = null;

	// Helper: extract host from URL (e.g., tcp://192.168.1.4:2376 -> 192.168.1.4)
	function extractHostFromUrl(urlString: string): string | null {
		if (!urlString) return null;
		try {
			// Handle tcp:// and other protocols
			const normalized = urlString.replace(/^tcp:\/\//, 'http://');
			const url = new URL(normalized);
			return url.hostname;
		} catch {
			// Try regex fallback for non-standard URLs
			const match = urlString.match(/(?:\/\/)?([^:/]+)/);
			return match?.[1] || null;
		}
	}

	// Helper: get clickable URL for a port
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
			const host = extractHostFromUrl(env.host);
			if (host) return formatHostPortUrl(host, publicPort);
		} else if (connectionType === 'hawser-standard' && env.host) {
			const host = extractHostFromUrl(env.host);
			if (host) return formatHostPortUrl(host, publicPort);
		}

		// No public IP available for socket or hawser-edge
		return null;
	}

	// Helper: format uptime from status string
	function formatUptime(status: string): string {
		if (!status) return '-';
		const upMatch = status.match(/Up\s+(.+?)(?:\s+\(|$)/i);
		if (upMatch) return upMatch[1].trim();
		const exitMatch = status.match(/Exited.+?(\d+\s+\w+)\s+ago/i);
		if (exitMatch) return exitMatch[1] + ' ago';
		return '-';
	}

	// Helper: get container's primary IP address
	function getContainerIp(networks: Array<{ name: string; ipAddress: string }>): string {
		if (!networks || networks.length === 0) return '-';
		return networks[0]?.ipAddress || '-';
	}

	// Helper: format bytes to human readable
	function formatBytes(bytes: number, decimals = 1): string {
		if (bytes === 0) return '0B';
		const k = 1024;
		const sizes = ['B', 'K', 'M', 'G', 'T'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + sizes[i];
	}

	// Fetch container stats
	async function fetchStats() {
		try {
			const response = await fetch(appendEnvParam('/api/containers/stats', envId));
			const stats: ContainerStats[] = await response.json();
			const statsMap = new Map<string, ContainerStats>();
			const newHistory = new Map(containerStatsHistory);

			for (const stat of stats) {
				if (!stat.id) continue;
				statsMap.set(stat.id, stat);

				// Update history for all metrics
				const history = newHistory.get(stat.id) || { cpu: [], mem: [], netRx: [], netTx: [], diskR: [], diskW: [] };
				history.cpu = [...history.cpu.slice(-(MAX_HISTORY - 1)), stat.cpuPercent];
				history.mem = [...history.mem.slice(-(MAX_HISTORY - 1)), stat.memoryPercent];
				history.netRx = [...history.netRx.slice(-(MAX_HISTORY - 1)), stat.networkRx];
				history.netTx = [...history.netTx.slice(-(MAX_HISTORY - 1)), stat.networkTx];
				history.diskR = [...history.diskR.slice(-(MAX_HISTORY - 1)), stat.blockRead];
				history.diskW = [...history.diskW.slice(-(MAX_HISTORY - 1)), stat.blockWrite];
				newHistory.set(stat.id, history);
			}

			containerStats = statsMap;
			containerStatsHistory = newHistory;
			statsUpdateCount++; // Trigger reactivity for expanded rows
		} catch (error) {
			console.error('Failed to fetch container stats:', error);
		}
	}

	// Generate sparkline SVG path
	function generateSparklinePath(data: number[], width: number, height: number): string {
		if (data.length < 2) return '';
		const max = Math.max(...data, 1);
		const step = width / (data.length - 1);
		return data.map((val, i) => {
			const x = i * step;
			const y = height - (val / max) * height;
			return i === 0 ? `M ${x} ${y}` : `L ${x} ${y}`;
		}).join(' ');
	}

	// Generate area path for sparkline fill
	function generateAreaPath(data: number[], width: number, height: number): string {
		if (data.length < 2) return '';
		const max = Math.max(...data, 1);
		const step = width / (data.length - 1);
		const line = data.map((val, i) => {
			const x = i * step;
			const y = height - (val / max) * height;
			return i === 0 ? `M ${x} ${y}` : `L ${x} ${y}`;
		}).join(' ');
		return `${line} L ${width} ${height} L 0 ${height} Z`;
	}

	// Aggregate stats for a stack (sum of all running containers)
	interface StackStats {
		cpuPercent: number;
		memoryUsage: number;
		memoryLimit: number;
		networkRx: number;
		networkTx: number;
		blockRead: number;
		blockWrite: number;
		runningCount: number;
	}

	function getStackStats(stack: ComposeStackInfo): StackStats | null {
		if (!stack.containerDetails || stack.containerDetails.length === 0) return null;

		let cpuPercent = 0;
		let memoryUsage = 0;
		let memoryLimit = 0;
		let networkRx = 0;
		let networkTx = 0;
		let blockRead = 0;
		let blockWrite = 0;
		let runningCount = 0;

		for (const container of stack.containerDetails) {
			// Only aggregate stats from running containers
			if (container.state !== 'running') continue;

			const stats = containerStats.get(container.id);
			if (stats) {
				cpuPercent += stats.cpuPercent;
				memoryUsage += stats.memoryUsage;
				memoryLimit += stats.memoryLimit;
				networkRx += stats.networkRx;
				networkTx += stats.networkTx;
				blockRead += stats.blockRead;
				blockWrite += stats.blockWrite;
				runningCount++;
			}
		}

		if (runningCount === 0) return null;

		return { cpuPercent, memoryUsage, memoryLimit, networkRx, networkTx, blockRead, blockWrite, runningCount };
	}

	// Search and sort state
	let searchInput = $state('');
	let searchQuery = $state('');
	let sortField = $state<SortField>('name');
	let sortDirection = $state<SortDirection>('asc');

	// Status filter state
	const STATUS_FILTER_STORAGE_KEY = 'dockhand-stacks-status-filter';
	let statusFilter = $state<string[]>([]);

	// Stack status types with icons and colors
	const stackStatusTypes = [
		{ value: 'running', label: 'Running', icon: Play, color: 'text-emerald-500' },
		{ value: 'partial', label: 'Partial', icon: CircleDashed, color: 'text-amber-500' },
		{ value: 'stopped', label: 'Stopped', icon: Square, color: 'text-rose-500' },
		{ value: 'created', label: 'Created', icon: CircleDashed, color: 'text-slate-500' },
		{ value: 'not deployed', label: 'Not deployed', icon: Rocket, color: 'text-violet-500' }
	];

	function getStackStatusIcon(status: string) {
		const s = stackStatusTypes.find(t => t.value === status.toLowerCase());
		return s?.icon || Layers;
	}

	function loadStatusFilter() {
		try {
			const stored = localStorage.getItem(STATUS_FILTER_STORAGE_KEY);
			if (stored) {
				const parsed = JSON.parse(stored);
				if (Array.isArray(parsed)) {
					statusFilter = parsed;
				}
			}
		} catch {
			// Ignore localStorage errors
		}
	}

	function saveStatusFilter() {
		try {
			localStorage.setItem(STATUS_FILTER_STORAGE_KEY, JSON.stringify(statusFilter));
		} catch {
			// Ignore localStorage errors
		}
	}

	// Auto-save status filter changes
	$effect(() => {
		const filter = statusFilter;
		saveStatusFilter();
	});

	// Confirmation popover state
	let confirmDeleteName = $state<string | null>(null);
	let confirmStopName = $state<string | null>(null);
	let confirmDownName = $state<string | null>(null);

	// Stack operation loading state
	let stackActionLoading = $state<string | null>(null);

	// Container-level confirmation popover state
	let confirmStopContainerId = $state<string | null>(null);
	let confirmRestartContainerId = $state<string | null>(null);
	let confirmPauseContainerId = $state<string | null>(null);

	// Operation error state (for stack and container operations)
	let operationError = $state<{ id: string; title: string; message: string } | null>(null);

	// Error dialog state (for showing detailed errors)
	let errorDialogData = $state<{ title: string; message: string } | null>(null);

	function showErrorDialog(title: string, message: string) {
		errorDialogData = { title, message };
	}

	// Container inspect modal state
	let showInspectModal = $state(false);
	let inspectContainerId = $state('');
	let inspectContainerName = $state('');

	// File browser modal state
	let showFileBrowserModal = $state(false);
	let fileBrowserContainerId = $state('');
	let fileBrowserContainerName = $state('');

	// Multi-select state
	let selectedStacks = $state<Set<string>>(new Set());
	let confirmBulkStart = $state(false);
	let confirmBulkStop = $state(false);
	let confirmBulkDown = $state(false);
	let confirmBulkRestart = $state(false);
	let confirmBulkRemove = $state(false);

	// Batch operation modal state
	let showBatchOpModal = $state(false);
	let batchOpTitle = $state('');
	let batchOpOperation = $state('');
	let batchOpItems = $state<Array<{ id: string; name: string }>>([]);

	// Filtered and sorted stacks
	const filteredStacks = $derived.by(() => {
		let result = stacks;

		// Filter by search query
		if (searchQuery.trim()) {
			const query = searchQuery.toLowerCase();
			result = result.filter(stack =>
				stack.name.toLowerCase().includes(query) ||
				getDisplayStatus(stack).toLowerCase().includes(query)
			);
		}

		// Filter by status (uses display status so git "created" matches "not deployed")
		if (statusFilter.length > 0) {
			result = result.filter(stack => statusFilter.includes(getDisplayStatus(stack).toLowerCase()));
		}

		// Sort
		result = [...result].sort((a, b) => {
			let cmp = 0;
			switch (sortField) {
				case 'name':
					cmp = a.name.localeCompare(b.name);
					break;
				case 'containers':
					cmp = a.containers.length - b.containers.length;
					break;
				case 'status':
					cmp = getDisplayStatus(a).localeCompare(getDisplayStatus(b));
					break;
				case 'cpu':
					const cpuA = getStackStats(a)?.cpuPercent ?? -1;
					const cpuB = getStackStats(b)?.cpuPercent ?? -1;
					cmp = cpuA - cpuB;
					break;
				case 'memory':
					const memA = getStackStats(a)?.memoryUsage ?? -1;
					const memB = getStackStats(b)?.memoryUsage ?? -1;
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

	// Check if all filtered stacks are selected
	const allFilteredSelected = $derived(
		filteredStacks.length > 0 && filteredStacks.every(s => selectedStacks.has(s.name))
	);
	const someFilteredSelected = $derived(
		filteredStacks.some(s => selectedStacks.has(s.name)) && !allFilteredSelected
	);
	const selectedInFilter = $derived(
		filteredStacks.filter(s => selectedStacks.has(s.name))
	);

	// Count by status for selected stacks
	const selectedRunning = $derived(selectedInFilter.filter(s => s.status === 'running' || s.status === 'partial' || s.status === 'restarting'));
	const selectedStopped = $derived(selectedInFilter.filter(s => s.status === 'stopped' || s.status === 'not deployed' || s.status === 'created'));

	function toggleSelectAll() {
		if (allFilteredSelected) {
			filteredStacks.forEach(s => selectedStacks.delete(s.name));
		} else {
			filteredStacks.forEach(s => selectedStacks.add(s.name));
		}
		selectedStacks = new Set(selectedStacks);
	}

	function selectNone() {
		selectedStacks = new Set();
	}

	function toggleStackSelection(stackName: string) {
		if (selectedStacks.has(stackName)) {
			selectedStacks.delete(stackName);
		} else {
			selectedStacks.add(stackName);
		}
		selectedStacks = new Set(selectedStacks);
	}

	function bulkStart() {
		batchOpTitle = `Starting ${selectedStopped.length} stack${selectedStopped.length !== 1 ? 's' : ''}`;
		batchOpOperation = 'start';
		batchOpItems = selectedStopped.map(s => ({ id: s.name, name: s.name }));
		showBatchOpModal = true;
	}

	function bulkStop() {
		batchOpTitle = `Stopping ${selectedRunning.length} stack${selectedRunning.length !== 1 ? 's' : ''}`;
		batchOpOperation = 'stop';
		batchOpItems = selectedRunning.map(s => ({ id: s.name, name: s.name }));
		showBatchOpModal = true;
	}

	function bulkDown() {
		batchOpTitle = `Bringing down ${selectedRunning.length} stack${selectedRunning.length !== 1 ? 's' : ''}`;
		batchOpOperation = 'down';
		batchOpItems = selectedRunning.map(s => ({ id: s.name, name: s.name }));
		showBatchOpModal = true;
	}

	function bulkRestart() {
		batchOpTitle = `Restarting ${selectedRunning.length} stack${selectedRunning.length !== 1 ? 's' : ''}`;
		batchOpOperation = 'restart';
		batchOpItems = selectedRunning.map(s => ({ id: s.name, name: s.name }));
		showBatchOpModal = true;
	}

	function bulkRemove() {
		batchOpTitle = `Removing ${selectedInFilter.length} stack${selectedInFilter.length !== 1 ? 's' : ''}`;
		batchOpOperation = 'remove';
		batchOpItems = selectedInFilter.map(s => ({ id: s.name, name: s.name }));
		showBatchOpModal = true;
	}

	function handleBatchComplete() {
		selectedStacks = new Set();
		fetchStacks();
	}

	// Expanded rows state - load from localStorage
	const EXPANDED_STORAGE_KEY = 'dockhand-stacks-expanded';
	let expandedStacks = $state<Set<string>>(new Set());

	// Load expanded state from localStorage on init
	function loadExpandedState() {
		try {
			const stored = localStorage.getItem(EXPANDED_STORAGE_KEY);
			if (stored) {
				const parsed = JSON.parse(stored);
				if (Array.isArray(parsed)) {
					expandedStacks = new Set(parsed);
				}
			}
		} catch {
			// Ignore localStorage errors
		}
	}

	// Save expanded state to localStorage
	function saveExpandedState() {
		try {
			localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(Array.from(expandedStacks)));
		} catch {
			// Ignore localStorage errors
		}
	}

	function toggleExpand(stackName: string) {
		if (expandedStacks.has(stackName)) {
			expandedStacks.delete(stackName);
		} else {
			expandedStacks.add(stackName);
		}
		expandedStacks = new Set(expandedStacks);
		saveExpandedState();
	}

	function expandAll() {
		expandedStacks = new Set(stacks.map(s => s.name));
		saveExpandedState();
	}

	function collapseAll() {
		expandedStacks = new Set();
		saveExpandedState();
	}

	// Check if all stacks are expanded
	const allExpanded = $derived(stacks.length > 0 && stacks.every(s => expandedStacks.has(s.name)));
	const someExpanded = $derived(expandedStacks.size > 0);

	// Debounce search input
	let searchTimeout: ReturnType<typeof setTimeout>;
	$effect(() => {
		const input = searchInput; // Track dependency
		clearTimeout(searchTimeout);
		searchTimeout = setTimeout(() => {
			searchQuery = input;
		}, 200);
		return () => clearTimeout(searchTimeout);
	});

	// Track last loaded environment to show skeleton on environment change
	let lastLoadedEnvId = $state<number | null>(null);

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
			fetchStacks();
			fetchStats();
		} else if (!env) {
			// No environment - clear data and stop loading
			envId = null;
			stacks = [];
			containerStats = new Map();
			loading = false;
		}
	});

	async function fetchStacks() {
		// Show loading skeleton on initial load or when environment changes, but not on refreshes
		if (lastLoadedEnvId !== envId) {
			loading = true;
		}
		try {
			const [stacksRes, sourcesRes, gitStacksRes] = await Promise.all([
				fetch(appendEnvParam('/api/stacks', envId)),
				fetch(appendEnvParam('/api/stacks/sources', envId)),
				fetch(appendEnvParam('/api/git/stacks', envId))
			]);

			// Handle stale environment ID (e.g., after database reset)
			if (stacksRes.status === 404 && envId) {
				console.warn(`[Stacks] Got 404 for env ${envId}, refreshing environments`);
				clearStaleEnvironment(envId);
				environments.refresh();
				return;
			}

			// Safe JSON parsing - handle potential non-JSON responses
			const safeJson = async (res: Response, fallback: any) => {
				try {
					return await res.json();
				} catch {
					console.warn(`[Stacks] Failed to parse response from ${res.url}`);
					return fallback;
				}
			};

			const dockerStacks = await safeJson(stacksRes, []);
			const sourcesData = await safeJson(sourcesRes, {});
			const gitStacksData = await safeJson(gitStacksRes, []);

			// Debug logging
			if (gitStacksData?.error) {
				console.error('Git stacks API error:', gitStacksData.error, 'Status:', gitStacksRes.status);
			}

			// Ensure responses are valid before using them
			stackSources = sourcesData && !sourcesData.error ? sourcesData : {};
			gitStacks = Array.isArray(gitStacksData) ? gitStacksData : [];

			// Add gitStack details to all git-based stacks
			// Note: The API already includes undeployed stacks from the database,
			// so we just need to attach the gitStack object for additional metadata
			for (const gs of gitStacks) {
				if (!stackSources[gs.stackName]) {
					// Git stack not in sources yet - create source entry
					stackSources[gs.stackName] = {
						sourceType: 'git',
						repository: gs.repository,
						gitStack: gs
					};
				} else if (stackSources[gs.stackName].sourceType === 'git') {
					// Git stack already in sources - add gitStack object
					stackSources[gs.stackName].gitStack = gs;
				}
			}

			stacks = dockerStacks;

			// Fetch env var counts for internal and git stacks (in background, don't block UI)
			const allStackNames = stacks.map(s => s.name);
			fetchEnvVarCounts(allStackNames, sourcesData);
		} catch (error) {
			console.error('Failed to fetch stacks:', error);
			toast.error('Failed to load stacks');
		} finally {
			loading = false;
			lastLoadedEnvId = envId;
		}
	}

	async function fetchEnvVarCounts(stackNames: string[], sources: Record<string, any>) {
		// Only fetch for stacks that can have env vars (internal or git)
		const stacksToFetch = stackNames.filter(name => {
			const source = sources[name];
			return source && (source.sourceType === 'internal' || source.sourceType === 'git');
		});

		if (stacksToFetch.length === 0) {
			stackEnvVarCounts = {};
			return;
		}

		const counts: Record<string, number> = {};

		// Fetch in parallel with error handling
		await Promise.all(stacksToFetch.map(async (stackName) => {
			try {
				const response = await fetch(appendEnvParam(`/api/stacks/${encodeURIComponent(stackName)}/env`, envId));
				if (response.ok) {
					const data = await response.json();
					const varCount = data.variables?.length || 0;
					if (varCount > 0) {
						counts[stackName] = varCount;
					}
				}
			} catch (e) {
				// Ignore errors for individual stack env var fetches
			}
		}));

		stackEnvVarCounts = counts;
	}

	function getStackSource(stackName: string) {
		return stackSources[stackName] || { sourceType: 'external' };
	}

	function getDisplayStatus(stack: ComposeStackInfo): string {
		if (stack.status === 'created' && getStackSource(stack.name).sourceType === 'git') {
			return 'not deployed';
		}
		return stack.status;
	}

	async function openGitModal(gitStack?: any) {
		editingGitStack = gitStack || null;
		// Fetch repositories and credentials before opening modal
		try {
			const [reposRes, credsRes] = await Promise.all([
				fetch('/api/git/repositories'),
				fetch('/api/git/credentials')
			]);
			gitRepositories = await reposRes.json();
			gitCredentials = await credsRes.json();
		} catch (error) {
			console.error('Failed to fetch git data:', error);
			gitRepositories = [];
			gitCredentials = [];
		}
		showGitModal = true;
	}

	async function startStack(name: string) {
		operationError = null;
		stackActionLoading = name;
		try {
			const response = await fetch(appendEnvParam(`/api/stacks/${encodeURIComponent(name)}/start`, envId), { method: 'POST' });
			if (!response.ok) {
				const rawText = await response.text();
				let errorMsg = 'Failed to start stack';
				try {
					const data = JSON.parse(rawText);
					errorMsg = data.error || errorMsg;
				} catch {
					errorMsg = rawText || errorMsg;
				}
				showErrorDialog(`Failed to start ${name}`, errorMsg);
				return;
			}
			toast.success(`Started ${name}`);
			await fetchStacks();
		} catch (error) {
			console.error('Failed to start stack:', error);
			const errorMsg = error instanceof Error ? error.message : 'Failed to start stack';
			showErrorDialog(`Failed to start ${name}`, errorMsg);
		} finally {
			stackActionLoading = null;
		}
	}

	async function stopStack(name: string) {
		operationError = null;
		stackActionLoading = name;
		try {
			const response = await fetch(appendEnvParam(`/api/stacks/${encodeURIComponent(name)}/stop`, envId), { method: 'POST' });
			if (!response.ok) {
				const rawText = await response.text();
				let errorMsg = 'Failed to stop stack';
				try {
					const data = JSON.parse(rawText);
					errorMsg = data.error || errorMsg;
				} catch {
					errorMsg = rawText || errorMsg;
				}
				showErrorDialog(`Failed to stop ${name}`, errorMsg);
				return;
			}
			toast.success(`Stopped ${name}`);
			await fetchStacks();
		} catch (error) {
			console.error('Failed to stop stack:', error);
			const errorMsg = error instanceof Error ? error.message : 'Failed to stop stack';
			showErrorDialog(`Failed to stop ${name}`, errorMsg);
		} finally {
			stackActionLoading = null;
		}
	}

	async function restartStack(name: string) {
		operationError = null;
		stackActionLoading = name;
		try {
			const response = await fetch(appendEnvParam(`/api/stacks/${encodeURIComponent(name)}/restart`, envId), { method: 'POST' });
			if (!response.ok) {
				const rawText = await response.text();
				let errorMsg = 'Failed to restart stack';
				try {
					const data = JSON.parse(rawText);
					errorMsg = data.error || errorMsg;
				} catch {
					errorMsg = rawText || errorMsg;
				}
				showErrorDialog(`Failed to restart ${name}`, errorMsg);
				return;
			}
			toast.success(`Restarted ${name}`);
			await fetchStacks();
		} catch (error) {
			console.error('Failed to restart stack:', error);
			const errorMsg = error instanceof Error ? error.message : 'Failed to restart stack';
			showErrorDialog(`Failed to restart ${name}`, errorMsg);
		} finally {
			stackActionLoading = null;
		}
	}

	async function downStack(name: string) {
		operationError = null;
		stackActionLoading = name;
		try {
			const response = await fetch(appendEnvParam(`/api/stacks/${encodeURIComponent(name)}/down`, envId), { method: 'POST' });
			// Log raw response for debugging
			const rawText = await response.text();
			console.log(`[downStack] Response status: ${response.status}, raw body:`, rawText);

			if (!response.ok) {
				let errorMsg = 'Failed to bring down stack';
				try {
					const data = JSON.parse(rawText);
					errorMsg = data.error || errorMsg;
				} catch {
					// Response may not be valid JSON
					errorMsg = rawText || errorMsg;
				}
				showErrorDialog(`Failed to bring down ${name}`, errorMsg);
				return;
			}
			toast.success(`Brought down ${name}`);
			await fetchStacks();
		} catch (error) {
			console.error('Failed to bring down stack:', error);
			const errorMsg = error instanceof Error ? error.message : 'Failed to bring down stack';
			showErrorDialog(`Failed to bring down ${name}`, errorMsg);
		} finally {
			stackActionLoading = null;
		}
	}

	function viewStackLogs(stack: ComposeStackInfo) {
		// Navigate to logs page with all containers from the stack (grouped mode)
		// Use containerDetails for full info, or fall back to containers (which is already string[])
		const containerIds = stack.containerDetails
			?.map(c => c.id)
			.filter((id): id is string => !!id)
			.join(',') || stack.containers?.filter(Boolean).join(',');
		if (containerIds) {
			const url = appendEnvParam(`/logs?containers=${containerIds}&stack=${encodeURIComponent(stack.name)}`, envId);
			goto(url);
		}
	}

	async function removeStack(name: string) {
		operationError = null;
		try {
			const response = await fetch(appendEnvParam(`/api/stacks/${encodeURIComponent(name)}?force=true`, envId), { method: 'DELETE' });
			if (!response.ok) {
				const data = await response.json();
				const errorMsg = data.error || 'Failed to remove stack';
				showErrorDialog(`Failed to remove ${name}`, errorMsg);
				return;
			}
			toast.success(`Removed ${name}`);
			await fetchStacks();
		} catch (error) {
			console.error('Failed to remove stack:', error);
			const errorMsg = error instanceof Error ? error.message : 'Failed to remove stack';
			showErrorDialog(`Failed to remove ${name}`, errorMsg);
		}
	}

	function editStack(name: string) {
		editingStackName = name;
		showEditModal = true;
	}

	function getStatusClasses(status: string): string {
		const base = 'text-xs px-1.5 py-0.5 rounded-sm font-medium inline-flex items-center gap-1 w-[6rem] justify-center shadow-sm whitespace-nowrap';
		switch (status.toLowerCase()) {
			case 'running':
				return `${base} bg-emerald-200 dark:bg-emerald-800 text-emerald-900 dark:text-emerald-100`;
			case 'stopped':
				return `${base} bg-red-200 dark:bg-red-800 text-red-900 dark:text-red-100`;
			case 'partial':
				return `${base} bg-amber-200 dark:bg-amber-800 text-amber-900 dark:text-amber-100`;
			case 'created':
				return `${base} bg-slate-200 dark:bg-slate-700 text-slate-900 dark:text-slate-100`;
			case 'not deployed':
				return `${base} bg-violet-200 dark:bg-violet-800 text-violet-900 dark:text-violet-100`;
			default:
				return `${base} bg-slate-200 dark:bg-slate-700 text-slate-900 dark:text-slate-100`;
		}
	}

	function toggleSort(field: SortField) {
		if (sortField === field) {
			sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
		} else {
			sortField = field;
			sortDirection = field === 'containers' ? 'desc' : 'asc';
		}
	}

	// Container actions
	let containerActionLoading = $state<string | null>(null);

	async function startContainer(containerId: string, e: Event) {
		e.stopPropagation();
		operationError = null;
		containerActionLoading = containerId;
		try {
			const response = await fetch(appendEnvParam(`/api/containers/${containerId}/start`, envId), { method: 'POST' });
			if (!response.ok) {
				const data = await response.json();
				const errorMsg = data.error || 'Failed to start container';
				operationError = { id: containerId, message: errorMsg };
				toast.error(errorMsg);
				clearErrorAfterDelay(containerId);
				return;
			}
			toast.success('Container started');
			await fetchStacks();
		} catch (error) {
			console.error('Failed to start container:', error);
			const errorMsg = error instanceof Error ? error.message : 'Failed to start container';
			operationError = { id: containerId, message: errorMsg };
			toast.error(errorMsg);
			clearErrorAfterDelay(containerId);
		} finally {
			containerActionLoading = null;
		}
	}

	async function stopContainer(containerId: string) {
		operationError = null;
		containerActionLoading = containerId;
		try {
			const response = await fetch(appendEnvParam(`/api/containers/${containerId}/stop`, envId), { method: 'POST' });
			if (!response.ok) {
				const data = await response.json();
				const errorMsg = data.error || 'Failed to stop container';
				operationError = { id: containerId, message: errorMsg };
				toast.error(errorMsg);
				clearErrorAfterDelay(containerId);
				return;
			}
			toast.success('Container stopped');
			await fetchStacks();
		} catch (error) {
			console.error('Failed to stop container:', error);
			const errorMsg = error instanceof Error ? error.message : 'Failed to stop container';
			operationError = { id: containerId, message: errorMsg };
			toast.error(errorMsg);
			clearErrorAfterDelay(containerId);
		} finally {
			containerActionLoading = null;
		}
	}

	async function restartContainer(containerId: string) {
		operationError = null;
		containerActionLoading = containerId;
		try {
			const response = await fetch(appendEnvParam(`/api/containers/${containerId}/restart`, envId), { method: 'POST' });
			if (!response.ok) {
				const data = await response.json();
				const errorMsg = data.error || 'Failed to restart container';
				operationError = { id: containerId, message: errorMsg };
				toast.error(errorMsg);
				clearErrorAfterDelay(containerId);
				return;
			}
			toast.success('Container restarted');
			await fetchStacks();
		} catch (error) {
			console.error('Failed to restart container:', error);
			const errorMsg = error instanceof Error ? error.message : 'Failed to restart container';
			operationError = { id: containerId, message: errorMsg };
			toast.error(errorMsg);
			clearErrorAfterDelay(containerId);
		} finally {
			containerActionLoading = null;
		}
	}

	async function pauseContainer(containerId: string) {
		operationError = null;
		containerActionLoading = containerId;
		try {
			const response = await fetch(appendEnvParam(`/api/containers/${containerId}/pause`, envId), { method: 'POST' });
			if (!response.ok) {
				const data = await response.json();
				const errorMsg = data.error || 'Failed to pause container';
				operationError = { id: containerId, message: errorMsg };
				toast.error(errorMsg);
				clearErrorAfterDelay(containerId);
				return;
			}
			toast.success('Container paused');
			await fetchStacks();
		} catch (error) {
			console.error('Failed to pause container:', error);
			const errorMsg = error instanceof Error ? error.message : 'Failed to pause container';
			operationError = { id: containerId, message: errorMsg };
			toast.error(errorMsg);
			clearErrorAfterDelay(containerId);
		} finally {
			containerActionLoading = null;
		}
	}

	async function unpauseContainer(containerId: string, e: Event) {
		e.stopPropagation();
		operationError = null;
		containerActionLoading = containerId;
		try {
			const response = await fetch(appendEnvParam(`/api/containers/${containerId}/unpause`, envId), { method: 'POST' });
			if (!response.ok) {
				const data = await response.json();
				const errorMsg = data.error || 'Failed to unpause container';
				operationError = { id: containerId, message: errorMsg };
				toast.error(errorMsg);
				clearErrorAfterDelay(containerId);
				return;
			}
			toast.success('Container unpaused');
			await fetchStacks();
		} catch (error) {
			console.error('Failed to unpause container:', error);
			const errorMsg = error instanceof Error ? error.message : 'Failed to unpause container';
			operationError = { id: containerId, message: errorMsg };
			toast.error(errorMsg);
			clearErrorAfterDelay(containerId);
		} finally {
			containerActionLoading = null;
		}
	}

	function inspectContainer(containerId: string, containerName: string) {
		inspectContainerId = containerId;
		inspectContainerName = containerName;
		showInspectModal = true;
	}

	function browseFiles(containerId: string, containerName: string) {
		fileBrowserContainerId = containerId;
		fileBrowserContainerName = containerName;
		showFileBrowserModal = true;
	}

	function getHealthClasses(health: string | undefined): string {
		switch (health) {
			case 'healthy':
				return 'text-emerald-500';
			case 'unhealthy':
				return 'text-red-500';
			case 'starting':
				return 'text-amber-500';
			default:
				return 'text-muted-foreground';
		}
	}

	function getContainerStateCounts(stack: ComposeStackInfo): Record<string, number> {
		const counts: Record<string, number> = {};
		if (stack.containerDetails) {
			for (const container of stack.containerDetails) {
				const state = container.state.toLowerCase();
				counts[state] = (counts[state] || 0) + 1;
			}
		}
		return counts;
	}

	function getStackNetworkCount(stack: ComposeStackInfo): number {
		if (!stack.containerDetails) return 0;
		const uniqueNetworks = new Set<string>();
		for (const container of stack.containerDetails) {
			for (const network of container.networks) {
				uniqueNetworks.add(network.name);
			}
		}
		return uniqueNetworks.size;
	}

	function getStackVolumeCount(stack: ComposeStackInfo): number {
		if (!stack.containerDetails) return 0;
		return stack.containerDetails.reduce((sum, c) => sum + c.volumeCount, 0);
	}

	// Handle tab visibility changes (e.g., user switches back from another tab)
	function handleVisibilityChange() {
		if (document.visibilityState === 'visible' && envId) {
			fetchStacks();
			fetchStats();
		}
	}

	onMount(() => {
		loadExpandedState();
		loadStatusFilter();

		// Check for search query param from URL (e.g., from container stack link)
		const urlSearch = $page.url.searchParams.get('search');
		if (urlSearch) {
			searchInput = urlSearch;
			searchQuery = urlSearch;
		}

		// Initial fetch is handled by $effect - no need to duplicate here

		// Listen for tab visibility changes to refresh when user returns
		document.addEventListener('visibilitychange', handleVisibilityChange);
		document.addEventListener('resume', handleVisibilityChange);

		// Subscribe to container events (stacks are identified by container labels)
		unsubscribeDockerEvent = onDockerEvent((event) => {
			if (envId && isContainerListChange(event)) {
				fetchStacks();
				fetchStats();
			}
		});

		// Refresh stacks every 30 seconds (use module-scope vars for cleanup)
		stacksInterval = setInterval(() => {
			if (envId) fetchStacks();
		}, 30000);

		// Refresh stats every 5 seconds (faster for resource monitoring)
		statsInterval = setInterval(() => {
			if (envId) fetchStats();
		}, 5000);

		// Note: In Svelte 5, cleanup must be in onDestroy, not returned from onMount
	});

	// Cleanup on component destroy
	onDestroy(() => {
		// Clear polling intervals
		if (stacksInterval) {
			clearInterval(stacksInterval);
			stacksInterval = null;
		}
		if (statsInterval) {
			clearInterval(statsInterval);
			statsInterval = null;
		}

		// Unsubscribe from Docker events
		if (unsubscribeDockerEvent) {
			unsubscribeDockerEvent();
			unsubscribeDockerEvent = null;
		}

		document.removeEventListener('visibilitychange', handleVisibilityChange);
		document.removeEventListener('resume', handleVisibilityChange);
	});
</script>

<div class="flex-1 min-h-0 flex flex-col gap-3 overflow-hidden">
	<div class="shrink-0 flex flex-wrap justify-between items-center gap-3 min-h-8">
		<PageHeader icon={Layers} title="Compose stacks" count={stacks.length}>
			{#if stacks.length > 0}
				<button
					type="button"
					onclick={allExpanded ? collapseAll : expandAll}
					class="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full border border-border hover:border-foreground/30 hover:shadow-sm transition-all cursor-pointer text-muted-foreground hover:text-foreground"
					title={allExpanded ? 'Collapse all' : 'Expand all'}
				>
					{#if allExpanded}
						<ChevronsDownUp class="w-3 h-3" />
						Collapse
					{:else}
						<ChevronsUpDown class="w-3 h-3" />
						Expand
					{/if}
				</button>
			{/if}
		</PageHeader>
		<div class="flex flex-wrap items-center gap-2">
			<div class="relative">
				<Search class="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
				<Input
					type="text"
					placeholder="Search stacks..."
					bind:value={searchInput}
					onkeydown={(e) => e.key === 'Escape' && (searchInput = '')}
					class="pl-8 h-8 w-48 text-sm"
				/>
			</div>
			<MultiSelectFilter
				bind:value={statusFilter}
				options={stackStatusTypes}
				placeholder="All statuses"
				pluralLabel="statuses"
				width="w-44"
				defaultIcon={Layers}
			/>
			<Button size="sm" variant="outline" onclick={fetchStacks}>
				<RefreshCw class="w-3.5 h-3.5" />
				Refresh
			</Button>
			{#if $canAccess('stacks', 'create')}
				<Button size="sm" variant="outline" onclick={() => openGitModal()}>
					<GitBranch class="w-3.5 h-3.5" />
					From Git
				</Button>
				<Button size="sm" variant="secondary" onclick={() => showCreateModal = true}>
					<Plus class="w-3.5 h-3.5" />
					Create
				</Button>
				<Button size="sm" variant="outline" onclick={() => showImportModal = true}>
					<Import class="w-3.5 h-3.5" />
					Adopt
				</Button>
			{/if}
		</div>
	</div>

	<!-- Selection bar - always reserve space to prevent layout shift -->
	<div class="h-4 shrink-0">
		{#if selectedStacks.size > 0}
			<div class="flex items-center gap-1 text-xs text-muted-foreground h-full">
			<span>{selectedInFilter.length} selected</span>
			<button
				type="button"
				class="inline-flex items-center gap-1 px-1.5 py-0 rounded border border-border hover:border-foreground/30 hover:shadow transition-all"
				onclick={selectNone}
			>
				Clear
			</button>
			{#if selectedStopped.length > 0 && $canAccess('stacks', 'start')}
				<ConfirmPopover
					open={confirmBulkStart}
					action="Start"
					itemType="stacks"
					itemName="{selectedStopped.length} stack{selectedStopped.length !== 1 ? 's' : ''}"
					title="Start {selectedStopped.length}"
					variant="secondary"
					unstyled
					onConfirm={bulkStart}
					onOpenChange={(open) => confirmBulkStart = open}
				>
					{#snippet children({ open })}
						<span class="inline-flex items-center gap-1 px-1.5 py-0 rounded border border-border hover:text-green-600 hover:border-green-500/40 hover:shadow transition-all cursor-pointer">
							<Play class="w-3 h-3" />
							Start
						</span>
					{/snippet}
				</ConfirmPopover>
			{/if}
			{#if selectedRunning.length > 0 && $canAccess('stacks', 'restart')}
				<ConfirmPopover
					open={confirmBulkRestart}
					action="Restart"
					itemType="stacks"
					itemName="{selectedRunning.length} stack{selectedRunning.length !== 1 ? 's' : ''}"
					title="Restart {selectedRunning.length}"
					variant="secondary"
					unstyled
					onConfirm={bulkRestart}
					onOpenChange={(open) => confirmBulkRestart = open}
				>
					{#snippet children({ open })}
						<span class="inline-flex items-center gap-1 px-1.5 py-0 rounded border border-border hover:text-amber-600 hover:border-amber-500/40 hover:shadow transition-all cursor-pointer">
							<RotateCcw class="w-3 h-3" />
							Restart
						</span>
					{/snippet}
				</ConfirmPopover>
			{/if}
			{#if selectedRunning.length > 0 && $canAccess('stacks', 'stop')}
				<ConfirmPopover
					open={confirmBulkStop}
					action="Stop"
					itemType="stacks"
					itemName="{selectedRunning.length} stack{selectedRunning.length !== 1 ? 's' : ''}"
					title="Stop {selectedRunning.length}"
					unstyled
					onConfirm={bulkStop}
					onOpenChange={(open) => confirmBulkStop = open}
				>
					{#snippet children({ open })}
						<span class="inline-flex items-center gap-1 px-1.5 py-0 rounded border border-border hover:text-red-600 hover:border-red-500/40 hover:shadow transition-all cursor-pointer">
							<Square class="w-3 h-3" />
							Stop
						</span>
					{/snippet}
				</ConfirmPopover>
			{/if}
			{#if selectedRunning.length > 0 && $canAccess('stacks', 'stop')}
				<ConfirmPopover
					open={confirmBulkDown}
					action="Down"
					itemType="stacks"
					itemName="{selectedRunning.length} stack{selectedRunning.length !== 1 ? 's' : ''}"
					title="Down {selectedRunning.length}"
					unstyled
					onConfirm={bulkDown}
					onOpenChange={(open) => confirmBulkDown = open}
				>
					{#snippet children({ open })}
						<span class="inline-flex items-center gap-1 px-1.5 py-0 rounded border border-border hover:text-orange-600 hover:border-orange-500/40 hover:shadow transition-all cursor-pointer">
							<ArrowBigDown class="w-3 h-3" />
							Down
						</span>
					{/snippet}
				</ConfirmPopover>
			{/if}
			{#if $canAccess('stacks', 'remove')}
			<ConfirmPopover
				open={confirmBulkRemove}
				action="Remove"
				itemType="stacks"
				itemName="{selectedInFilter.length} stack{selectedInFilter.length !== 1 ? 's' : ''}"
				title="Remove {selectedInFilter.length}"
				unstyled
				onConfirm={bulkRemove}
				onOpenChange={(open) => confirmBulkRemove = open}
			>
				{#snippet children({ open })}
					<span class="inline-flex items-center gap-1 px-1.5 py-0 rounded border border-border hover:text-destructive hover:border-destructive/40 hover:shadow transition-all cursor-pointer">
						<Trash2 class="w-3 h-3" />
						Remove
					</span>
				{/snippet}
			</ConfirmPopover>
			{/if}
			</div>
		{/if}
	</div>

	{#if !loading && ($environments.length === 0 || !$currentEnvironment)}
		<NoEnvironment />
	{:else if !loading && stacks.length === 0}
		<EmptyState
			icon={Layers}
			title="No compose stacks found"
			description="Create a stack or deploy from Git to get started"
		/>
	{:else}
		<DataGrid
			data={filteredStacks}
			keyField="name"
			gridId="stacks"
			loading={loading}
			selectable
			bind:selectedKeys={selectedStacks}
			expandable
			bind:expandedKeys={expandedStacks}
			onExpandChange={(key, expanded) => saveExpandedState()}
			sortState={{ field: sortField, direction: sortDirection }}
			onSortChange={(state) => {
				sortField = state.field as SortField;
				sortDirection = state.direction;
			}}
			onRowClick={(stack, e) => {
				toggleExpand(stack.name);
			}}
			rowClass={(stack) => {
				const isExp = expandedStacks.has(stack.name);
				const isSel = selectedStacks.has(stack.name);
				return `${isExp ? 'bg-muted/40' : ''} ${isSel ? 'bg-muted/30' : ''}`;
			}}
		>
			{#snippet cell(column, stack, rowState)}
				{@const source = getStackSource(stack.name)}
				{#if column.id === 'name'}
					{#if source.sourceType !== 'git'}
						<!-- Internal stacks (including those needing file location) are clickable -->
						<button
							type="button"
							class="font-medium text-xs hover:text-primary hover:underline cursor-pointer text-left"
							onclick={() => editStack(stack.name)}
						>
							{stack.name}
						</button>
					{:else}
						<!-- Git stacks open in GitStackModal instead -->
						<span class="font-medium text-xs">{stack.name}</span>
					{/if}
					{#if stackEnvVarCounts[stack.name]}
						<Tooltip.Root>
							<Tooltip.Trigger>
								<span class="inline-flex items-center gap-0.5 ml-1.5 text-2xs px-1 py-0.5 rounded bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300">
									<Variable class="w-2.5 h-2.5" />
									{stackEnvVarCounts[stack.name]}
								</span>
							</Tooltip.Trigger>
							<Tooltip.Content class="whitespace-nowrap">
								{stackEnvVarCounts[stack.name]} environment variable{stackEnvVarCounts[stack.name] !== 1 ? 's' : ''} configured
							</Tooltip.Content>
						</Tooltip.Root>
					{/if}
				{:else if column.id === 'source'}
					{#if source.sourceType === 'git'}
						<span
							class="inline-flex items-center justify-center gap-1 text-xs px-1.5 py-0.5 rounded-sm bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200 shadow-sm min-w-[5.5rem]"
							title={source.repository ? `${source.repository.url} (${source.repository.branch})` : 'Deployed from Git repository'}
						>
							<GitBranch class="w-3 h-3" />
							Git
						</span>
					{:else if source.sourceType === 'internal'}
						<span
							class="inline-flex items-center justify-center gap-1 text-xs px-1.5 py-0.5 rounded-sm bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 shadow-sm min-w-[5.5rem]"
							title="Managed by Dockhand"
						>
							<FileCode class="w-3 h-3" />
							Internal
						</span>
					{:else}
						<Tooltip.Root>
							<Tooltip.Trigger>
								<span
									class="inline-flex items-center justify-center gap-1 text-xs px-1.5 py-0.5 rounded-sm bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200 shadow-sm min-w-[5.5rem]"
								>
									<ExternalLink class="w-3 h-3" />
									Untracked
								</span>
							</Tooltip.Trigger>
							<Tooltip.Content class="whitespace-nowrap">
								Compose file location unknown. Click the stack name or edit button to locate it.
							</Tooltip.Content>
						</Tooltip.Root>
					{/if}
				{:else if column.id === 'location'}
					{#if source.composePath}
						{@const dirPath = source.composePath.replace(/\/[^/]+$/, '')}
						<Tooltip.Root>
							<Tooltip.Trigger class="w-full text-left">
								<span class="text-xs text-muted-foreground block truncate">
									{dirPath}
								</span>
							</Tooltip.Trigger>
							<Tooltip.Content class="max-w-md">
								<code class="text-xs">{source.composePath}</code>
							</Tooltip.Content>
						</Tooltip.Root>
					{:else}
						<span class="text-xs text-muted-foreground/50 italic">Not set</span>
					{/if}
				{:else if column.id === 'containers'}
					<div class="flex items-center gap-1">
						{#if getContainerStateCounts(stack).running}
							<span class="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400" title="Running">
								<Play class="w-3.5 h-3.5" />
								<span class="text-xs font-medium">{getContainerStateCounts(stack).running}</span>
							</span>
						{/if}
						{#if getContainerStateCounts(stack).exited}
							<span class="inline-flex items-center gap-0.5 text-red-600 dark:text-red-400" title="Exited">
								<Square class="w-3.5 h-3.5" />
								<span class="text-xs font-medium">{getContainerStateCounts(stack).exited}</span>
							</span>
						{/if}
						{#if getContainerStateCounts(stack).paused}
							<span class="inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400" title="Paused">
								<Pause class="w-3.5 h-3.5" />
								<span class="text-xs font-medium">{getContainerStateCounts(stack).paused}</span>
							</span>
						{/if}
						{#if getContainerStateCounts(stack).restarting}
							<span class="inline-flex items-center gap-0.5 text-blue-600 dark:text-blue-400" title="Restarting">
								<span class="w-3.5 h-3.5 flex items-center justify-center"><RefreshCw class="w-3.5 h-3.5 animate-spin" /></span>
								<span class="text-xs font-medium">{getContainerStateCounts(stack).restarting}</span>
							</span>
						{/if}
						{#if getContainerStateCounts(stack).created}
							<span class="inline-flex items-center gap-0.5 text-slate-500 dark:text-slate-400" title="Created">
								<CircleDashed class="w-3.5 h-3.5" />
								<span class="text-xs font-medium">{getContainerStateCounts(stack).created}</span>
							</span>
						{/if}
						{#if getContainerStateCounts(stack).dead}
							<span class="inline-flex items-center gap-0.5 text-rose-700 dark:text-rose-400" title="Dead">
								<Skull class="w-3.5 h-3.5" />
								<span class="text-xs font-medium">{getContainerStateCounts(stack).dead}</span>
							</span>
						{/if}
						{#if stack.containers.length === 0}
							<span class="text-xs text-muted-foreground">-</span>
						{/if}
					</div>
				{:else if column.id === 'cpu'}
					{@const stats = getStackStats(stack)}
					<div class="text-right">
						{#if stats}
							<span class="text-xs font-mono {stats.cpuPercent > 80 ? 'text-red-500' : stats.cpuPercent > 50 ? 'text-yellow-500' : 'text-muted-foreground'}">{stats.cpuPercent.toFixed(1)}%</span>
						{:else if stack.status === 'running' || stack.status === 'partial' || stack.status === 'restarting'}
							<span class="text-xs text-muted-foreground/50">...</span>
						{:else}
							<span class="text-gray-400 dark:text-gray-600 text-xs">-</span>
						{/if}
					</div>
				{:else if column.id === 'memory'}
					{@const stats = getStackStats(stack)}
					<div class="text-right">
						{#if stats}
							<span class="text-xs font-mono text-muted-foreground" title="{formatBytes(stats.memoryUsage)} / {formatBytes(stats.memoryLimit)}">{formatBytes(stats.memoryUsage)}</span>
						{:else if stack.status === 'running' || stack.status === 'partial' || stack.status === 'restarting'}
							<span class="text-xs text-muted-foreground/50">...</span>
						{:else}
							<span class="text-gray-400 dark:text-gray-600 text-xs">-</span>
						{/if}
					</div>
				{:else if column.id === 'networkIO'}
					{@const stats = getStackStats(stack)}
					<div class="text-right whitespace-nowrap">
						{#if stats}
							<span class="text-xs font-mono text-muted-foreground" title="↓{formatBytes(stats.networkRx)} received / ↑{formatBytes(stats.networkTx)} sent">
								<span class="text-2xs text-blue-400">↓</span>{formatBytes(stats.networkRx, 0)} <span class="text-2xs text-orange-400">↑</span>{formatBytes(stats.networkTx, 0)}
							</span>
						{:else if stack.status === 'running' || stack.status === 'partial' || stack.status === 'restarting'}
							<span class="text-xs text-muted-foreground/50">...</span>
						{:else}
							<span class="text-gray-400 dark:text-gray-600 text-xs">-</span>
						{/if}
					</div>
				{:else if column.id === 'diskIO'}
					{@const stats = getStackStats(stack)}
					<div class="text-right whitespace-nowrap">
						{#if stats}
							<span class="text-xs font-mono text-muted-foreground" title="↓{formatBytes(stats.blockRead)} read / ↑{formatBytes(stats.blockWrite)} written">
								<span class="text-2xs text-green-400">r</span>{formatBytes(stats.blockRead, 0)} <span class="text-2xs text-yellow-400">w</span>{formatBytes(stats.blockWrite, 0)}
							</span>
						{:else if stack.status === 'running' || stack.status === 'partial' || stack.status === 'restarting'}
							<span class="text-xs text-muted-foreground/50">...</span>
						{:else}
							<span class="text-gray-400 dark:text-gray-600 text-xs">-</span>
						{/if}
					</div>
				{:else if column.id === 'networks'}
					<span class="text-xs text-muted-foreground">
						{getStackNetworkCount(stack) || '-'}
					</span>
				{:else if column.id === 'volumes'}
					<span class="text-xs text-muted-foreground">
						{getStackVolumeCount(stack) || '-'}
					</span>
				{:else if column.id === 'status'}
					{@const displayStatus = getDisplayStatus(stack)}
					{@const StatusIcon = getStackStatusIcon(displayStatus)}
					<span class={getStatusClasses(displayStatus)}>
						<StatusIcon class="w-3 h-3" />
						{displayStatus}
					</span>
				{:else if column.id === 'actions'}
					<div class="relative flex gap-1 justify-end">
						{#if operationError?.id === stack.name && operationError?.message}
							<div class="absolute bottom-full right-0 mb-1 z-50 bg-destructive text-destructive-foreground rounded-md shadow-lg p-2 text-xs flex items-start gap-2 max-w-lg w-max">
								<AlertTriangle class="w-3 h-3 flex-shrink-0 mt-0.5" />
								<span class="break-words">{operationError.message}</span>
								<button onclick={() => operationError = null} class="flex-shrink-0 hover:bg-white/20 rounded p-0.5">
									<X class="w-3 h-3" />
								</button>
							</div>
						{/if}
						{#if (stack.status === 'not deployed' || stack.status === 'created') && source.gitStack}
							<button
								type="button"
								onclick={() => openGitModal(source.gitStack)}
								title="Edit git stack"
								class="p-1 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
							>
								<Pencil class="w-3 h-3 text-muted-foreground hover:text-purple-500" />
							</button>
							<GitDeployProgressPopover
								stackId={source.gitStack.id}
								stackName={stack.name}
								onComplete={fetchStacks}
							>
								{#snippet children()}
									<button
										type="button"
										title="Deploy"
										class="p-1 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
									>
										<Rocket class="w-3 h-3 text-muted-foreground hover:text-violet-500" />
									</button>
								{/snippet}
							</GitDeployProgressPopover>
						{:else}
							{#if source.sourceType === 'git' && source.gitStack}
								<GitDeployProgressPopover
									stackId={source.gitStack.id}
									stackName={stack.name}
									onComplete={fetchStacks}
								>
									{#snippet children()}
										<button
											type="button"
											title="Sync from Git"
											class="p-1 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
										>
											<RefreshCw class="w-3 h-3 text-muted-foreground hover:text-purple-500" />
										</button>
									{/snippet}
								</GitDeployProgressPopover>
							{/if}
							{#if $canAccess('stacks', 'edit')}
								{#if source.sourceType === 'git' && source.gitStack}
									<button
										type="button"
										onclick={() => openGitModal(source.gitStack)}
										title="Edit git stack"
										class="p-1 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
									>
										<Pencil class="w-3 h-3 text-muted-foreground hover:text-purple-500" />
									</button>
								{:else}
									<!-- Internal stacks (including those needing file location) -->
									<button
										type="button"
										onclick={() => editStack(stack.name)}
										title="Edit"
										class="p-1 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
									>
										<Pencil class="w-3 h-3 text-muted-foreground hover:text-blue-500" />
									</button>
								{/if}
							{/if}
							{#if stack.containers && stack.containers.length > 0}
								<button
									type="button"
									onclick={() => viewStackLogs(stack)}
									title="View logs"
									class="p-1 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
								>
									<ScrollText class="w-3 h-3 text-muted-foreground hover:text-blue-500" />
								</button>
							{/if}
							{#if stackActionLoading === stack.name}
								<div class="p-1">
									<Loader2 class="w-3 h-3 animate-spin text-muted-foreground" />
								</div>
							{:else if stack.status === 'running' || stack.status === 'partial' || stack.status === 'restarting'}
								{#if $canAccess('stacks', 'restart')}
									<ConfirmPopover
										open={false}
										action="Restart"
										itemType="stack"
										itemName={stack.name}
										title="Restart"
										onConfirm={() => restartStack(stack.name)}
										onOpenChange={() => {}}
									>
										{#snippet children({ open })}
											<RotateCcw class="w-3 h-3 {open ? 'text-amber-500' : 'text-muted-foreground hover:text-amber-500'}" />
										{/snippet}
									</ConfirmPopover>
								{/if}
								{#if $canAccess('stacks', 'stop')}
									<ConfirmPopover
										open={confirmStopName === stack.name}
										action="Stop"
										itemType="stack"
										itemName={stack.name}
										title="Stop"
										onConfirm={() => stopStack(stack.name)}
										onOpenChange={(open) => confirmStopName = open ? stack.name : null}
									>
										{#snippet children({ open })}
											<Square class="w-3 h-3 {open ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}" />
										{/snippet}
									</ConfirmPopover>
								{/if}
							{:else}
								{#if $canAccess('stacks', 'start')}
									<button
										type="button"
										onclick={() => startStack(stack.name)}
										title="Start"
										class="p-1 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
									>
										<Play class="w-3 h-3 text-muted-foreground hover:text-green-500" />
									</button>
								{/if}
							{/if}
						{/if}
						{#if $canAccess('stacks', 'stop')}
							<ConfirmPopover
								open={confirmDownName === stack.name}
								action="Down"
								itemType="stack"
								itemName={stack.name}
								title="Down (remove containers)"
								onConfirm={() => downStack(stack.name)}
								onOpenChange={(open) => confirmDownName = open ? stack.name : null}
							>
								{#snippet children({ open })}
									<ArrowBigDown class="w-3 h-3 {open ? 'text-orange-500' : 'text-muted-foreground hover:text-orange-500'}" />
								{/snippet}
							</ConfirmPopover>
						{/if}
						{#if $canAccess('stacks', 'remove')}
							<ConfirmPopover
								open={confirmDeleteName === stack.name}
								action="Delete"
								itemType="stack"
								itemName={stack.name}
								title="Remove"
								onConfirm={() => removeStack(stack.name)}
								onOpenChange={(open) => confirmDeleteName = open ? stack.name : null}
							>
								{#snippet children({ open })}
									<Trash2 class="w-3 h-3 {open ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}" />
								{/snippet}
							</ConfirmPopover>
						{/if}
					</div>
				{/if}
			{/snippet}

			{#snippet expandedRow(stack, rowState)}
				{#if stack.containerDetails?.length > 0}
					<div class="p-4 pl-12 shadow-inner bg-muted/30">
						<div class="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
							{#each stack.containerDetails as container (container.id)}
								{@const isLoading = containerActionLoading === container.id}
								<div class="p-3 rounded-lg bg-background border text-xs">
									<div class="flex items-center gap-2 mb-2">
										<Box class="w-4 h-4 shrink-0 {container.state === 'running' ? 'text-emerald-500' : 'text-muted-foreground'}" />
										<span class="font-medium truncate flex-1" title={container.name}>{container.service}</span>
										{#if container.health}
											<span title={container.health}>
												{#if container.health === 'healthy'}
													<HeartPulse class="w-3.5 h-3.5 {getHealthClasses(container.health)}" />
												{:else if container.health === 'unhealthy'}
													<HeartOff class="w-3.5 h-3.5 {getHealthClasses(container.health)}" />
												{:else}
													<Heart class="w-3.5 h-3.5 {getHealthClasses(container.health)}" />
												{/if}
											</span>
										{/if}
										<span class={getStatusClasses(container.state)}>{container.state}</span>
									</div>
									<div class="text-muted-foreground mb-2 space-y-0.5">
										<div class="truncate" title={container.image}>{container.image}</div>
										<div class="flex items-center gap-2 text-2xs">
											<span class="inline-flex items-center gap-1">
												<Clock class="w-2.5 h-2.5" />
												{formatUptime(container.status)}
											</span>
											{#if container.restartCount > 0}
												<span class="inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400" title="{container.restartCount} restart{container.restartCount > 1 ? 's' : ''}">
													<RotateCw class="w-2.5 h-2.5" />
													{container.restartCount}
												</span>
											{/if}
										</div>
									</div>
									<!-- CPU/Memory/Net/Disk mini sparkline graphs -->
									{#if container.state === 'running'}
										{@const stats = containerStats.get(container.id)}
										{@const history = containerStatsHistory.get(container.id)}
										{#key statsUpdateCount}
										<div class="grid grid-cols-4 gap-1.5 mb-2">
											<!-- CPU sparkline -->
											<div class="space-y-0">
												<div class="flex justify-between text-2xs">
													<span class="text-muted-foreground">CPU</span>
													<span class="font-mono {stats?.cpuPercent && stats.cpuPercent > 80 ? 'text-red-500' : stats?.cpuPercent && stats.cpuPercent > 50 ? 'text-yellow-500' : 'text-muted-foreground'}">{stats?.cpuPercent?.toFixed(0) ?? '-'}%</span>
												</div>
												{#if history?.cpu && history.cpu.length >= 2}
													<svg class="w-full h-4" viewBox="0 0 60 16" preserveAspectRatio="none">
														<path d={generateAreaPath(history.cpu, 60, 16)} fill="rgba(59, 130, 246, 0.15)" />
														<path d={generateSparklinePath(history.cpu, 60, 16)} fill="none" stroke="rgb(59, 130, 246)" stroke-width="1" />
													</svg>
												{:else}
													<div class="h-4 bg-muted/30 rounded animate-pulse"></div>
												{/if}
											</div>
											<!-- Memory sparkline -->
											<div class="space-y-0">
												<div class="flex justify-between text-2xs">
													<span class="text-muted-foreground">Mem</span>
													<span class="font-mono text-muted-foreground">{stats ? formatBytes(stats.memoryUsage) : '-'}</span>
												</div>
												{#if history?.mem && history.mem.length >= 2}
													<svg class="w-full h-4" viewBox="0 0 60 16" preserveAspectRatio="none">
														<path d={generateAreaPath(history.mem, 60, 16)} fill="rgba(168, 85, 247, 0.15)" />
														<path d={generateSparklinePath(history.mem, 60, 16)} fill="none" stroke="rgb(168, 85, 247)" stroke-width="1" />
													</svg>
												{:else}
													<div class="h-4 bg-muted/30 rounded animate-pulse"></div>
												{/if}
											</div>
											<!-- Network I/O sparkline -->
											<div class="space-y-0">
												<div class="flex justify-between text-2xs">
													<span class="text-muted-foreground">Net</span>
													<span class="font-mono text-muted-foreground">{stats ? formatBytes(stats.networkRx + stats.networkTx) : '-'}</span>
												</div>
												{#if history?.netRx && history.netRx.length >= 2}
													<svg class="w-full h-4" viewBox="0 0 60 16" preserveAspectRatio="none">
														<path d={generateAreaPath(history.netRx.map((rx, i) => rx + (history.netTx[i] || 0)), 60, 16)} fill="rgba(34, 197, 94, 0.15)" />
														<path d={generateSparklinePath(history.netRx.map((rx, i) => rx + (history.netTx[i] || 0)), 60, 16)} fill="none" stroke="rgb(34, 197, 94)" stroke-width="1" />
													</svg>
												{:else}
													<div class="h-4 bg-muted/30 rounded animate-pulse"></div>
												{/if}
											</div>
											<!-- Disk I/O sparkline -->
											<div class="space-y-0">
												<div class="flex justify-between text-2xs">
													<span class="text-muted-foreground">Disk</span>
													<span class="font-mono text-muted-foreground">{stats ? formatBytes(stats.blockRead + stats.blockWrite) : '-'}</span>
												</div>
												{#if history?.diskR && history.diskR.length >= 2}
													<svg class="w-full h-4" viewBox="0 0 60 16" preserveAspectRatio="none">
														<path d={generateAreaPath(history.diskR.map((r, i) => r + (history.diskW[i] || 0)), 60, 16)} fill="rgba(251, 146, 60, 0.15)" />
														<path d={generateSparklinePath(history.diskR.map((r, i) => r + (history.diskW[i] || 0)), 60, 16)} fill="none" stroke="rgb(251, 146, 60)" stroke-width="1" />
													</svg>
												{:else}
													<div class="h-4 bg-muted/30 rounded animate-pulse"></div>
												{/if}
											</div>
										</div>
										{/key}
									{/if}
									<div class="flex flex-wrap gap-1.5 mb-2 text-2xs">
										<!-- Clickable ports (dedupe by publicPort for IPv4/IPv6) -->
										{#if container.ports.length > 0}
											{@const uniquePorts = container.ports.filter((p, i, arr) => p.publicPort && arr.findIndex(x => x.publicPort === p.publicPort) === i)}
											{#each uniquePorts as port}
												{@const url = getPortUrl(port.publicPort)}
												{#if url}
													<a
														href={url}
														target="_blank"
														rel="noopener noreferrer"
														onclick={(e) => e.stopPropagation()}
														class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 hover:bg-blue-200 dark:hover:bg-blue-800 transition-colors"
														title="Open {url} in new tab"
													>
														<code>:{port.publicPort}</code>
														<ExternalLink class="w-2.5 h-2.5" />
													</a>
												{:else}
													<span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
														<code>:{port.publicPort}</code>
													</span>
												{/if}
											{/each}
										{/if}
										<!-- Network with IP -->
										{#if container.networks.length > 0}
											{@const ip = getContainerIp(container.networks)}
											<Tooltip.Root>
												<Tooltip.Trigger>
													<span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200">
														<Network class="w-2.5 h-2.5" />
														{ip !== '-' ? ip : container.networks.length}
													</span>
												</Tooltip.Trigger>
												<Tooltip.Content class="whitespace-nowrap max-w-none">
													{#each container.networks as net}
														<div class="font-mono text-xs">{net.name}: {net.ipAddress || 'no IP'}</div>
													{/each}
												</Tooltip.Content>
											</Tooltip.Root>
										{/if}
										<!-- Volumes -->
										{#if container.volumeCount > 0}
											<span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200" title="{container.volumeCount} volume{container.volumeCount > 1 ? 's' : ''} mounted">
												<HardDrive class="w-2.5 h-2.5" />
												{container.volumeCount}
											</span>
										{/if}
									</div>
									<div class="flex items-center justify-between pt-2 border-t border-muted">
										<div class="flex gap-1">
											<button
												type="button"
												title="View logs"
												onclick={(e) => { e.stopPropagation(); goto(appendEnvParam(`/logs?container=${container.id}`, envId)); }}
												class="p-1 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
											>
												<ScrollText class="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
											</button>
											{#if container.state === 'running' && $canAccess('containers', 'exec')}
												<button
													type="button"
													title="Open terminal"
													onclick={(e) => { e.stopPropagation(); goto(appendEnvParam(`/terminal?container=${container.id}`, envId)); }}
													class="p-1 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
												>
													<Terminal class="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
												</button>
											{/if}
											{#if container.state === 'running' && $canAccess('containers', 'files')}
												<button
													type="button"
													title="Browse files"
													onclick={(e) => { e.stopPropagation(); browseFiles(container.id, container.name); }}
													class="p-1 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
												>
													<FolderOpen class="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
												</button>
											{/if}
											<button
												type="button"
												title="Inspect container"
												onclick={(e) => { e.stopPropagation(); inspectContainer(container.id, container.name); }}
												class="p-1 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
											>
												<Eye class="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
											</button>
										</div>
										<div class="relative flex gap-1">
											{#if operationError?.id === container.id && operationError?.message}
												<div class="absolute bottom-full right-0 mb-1 z-50 bg-destructive text-destructive-foreground rounded-md shadow-lg p-2 text-xs flex items-start gap-2 max-w-lg w-max">
													<AlertTriangle class="w-3 h-3 flex-shrink-0 mt-0.5" />
													<span class="break-words">{operationError.message}</span>
													<button onclick={() => operationError = null} class="flex-shrink-0 hover:bg-white/20 rounded p-0.5">
														<X class="w-3 h-3" />
													</button>
												</div>
											{/if}
											{#if isLoading}
												<Loader2 class="w-3.5 h-3.5 animate-spin text-muted-foreground" />
											{:else}
												{#if container.state === 'running'}
													{#if $canAccess('containers', 'restart')}
														<ConfirmPopover
															open={confirmRestartContainerId === container.id}
															action="Restart"
															itemType="container"
															itemName={container.service}
															title="Restart"
															onConfirm={() => restartContainer(container.id)}
															onOpenChange={(open) => confirmRestartContainerId = open ? container.id : null}
														>
															{#snippet children({ open })}
																<RotateCcw class="w-3.5 h-3.5 {open ? 'text-amber-500' : 'text-muted-foreground hover:text-amber-500'}" />
															{/snippet}
														</ConfirmPopover>
													{/if}
													{#if $canAccess('containers', 'pause')}
														<ConfirmPopover
															open={confirmPauseContainerId === container.id}
															action="Pause"
															itemType="container"
															itemName={container.service}
															title="Pause"
															onConfirm={() => pauseContainer(container.id)}
															onOpenChange={(open) => confirmPauseContainerId = open ? container.id : null}
														>
															{#snippet children({ open })}
																<Pause class="w-3.5 h-3.5 {open ? 'text-amber-500' : 'text-muted-foreground hover:text-amber-500'}" />
															{/snippet}
														</ConfirmPopover>
													{/if}
													{#if $canAccess('containers', 'stop')}
														<ConfirmPopover
															open={confirmStopContainerId === container.id}
															action="Stop"
															itemType="container"
															itemName={container.service}
															title="Stop"
															onConfirm={() => stopContainer(container.id)}
															onOpenChange={(open) => confirmStopContainerId = open ? container.id : null}
														>
															{#snippet children({ open })}
																<Square class="w-3.5 h-3.5 {open ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}" />
															{/snippet}
														</ConfirmPopover>
													{/if}
												{:else if container.state === 'paused'}
													{#if $canAccess('containers', 'unpause')}
														<button
															type="button"
															title="Unpause"
															onclick={(e) => unpauseContainer(container.id, e)}
															class="p-1 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
														>
															<Play class="w-3.5 h-3.5 text-muted-foreground hover:text-emerald-500" />
														</button>
													{/if}
												{:else}
													{#if $canAccess('containers', 'start')}
														<button
															type="button"
															title="Start"
															onclick={(e) => startContainer(container.id, e)}
															class="p-1 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
														>
															<Play class="w-3.5 h-3.5 text-muted-foreground hover:text-emerald-500" />
														</button>
													{/if}
												{/if}
											{/if}
										</div>
									</div>
								</div>
							{/each}
						</div>
					</div>
				{:else}
					<div class="p-4 pl-12 shadow-inner bg-muted/30">
						<div class="flex items-center justify-center gap-2 py-4 text-muted-foreground text-sm">
							<Box class="w-4 h-4" />
							<span>No containers</span>
						</div>
					</div>
				{/if}
			{/snippet}
		</DataGrid>
	{/if}
</div>

<!-- Create Stack Modal -->
<StackModal
	bind:open={showCreateModal}
	mode="create"
	onClose={() => showCreateModal = false}
	onSuccess={fetchStacks}
/>

<!-- Edit Stack Modal -->
<StackModal
	bind:open={showEditModal}
	mode="edit"
	stackName={editingStackName}
	onClose={() => {
		showEditModal = false;
		editingStackName = '';
	}}
	onSuccess={fetchStacks}
/>

<GitStackModal
	bind:open={showGitModal}
	gitStack={editingGitStack}
	environmentId={envId}
	repositories={gitRepositories}
	credentials={gitCredentials}
	onClose={() => {
		showGitModal = false;
		editingGitStack = null;
	}}
	onSaved={fetchStacks}
/>

<ImportStackModal
	bind:open={showImportModal}
	onClose={() => showImportModal = false}
	onAdopted={fetchStacks}
/>

<ContainerInspectModal
	bind:open={showInspectModal}
	containerId={inspectContainerId}
	containerName={inspectContainerName}
/>

<FileBrowserModal
	bind:open={showFileBrowserModal}
	containerId={fileBrowserContainerId}
	containerName={fileBrowserContainerName}
	envId={envId ?? undefined}
	onclose={() => showFileBrowserModal = false}
/>

<BatchOperationModal
	bind:open={showBatchOpModal}
	title={batchOpTitle}
	operation={batchOpOperation}
	entityType="stacks"
	items={batchOpItems}
	envId={envId ?? undefined}
	options={{ force: true }}
	onClose={() => showBatchOpModal = false}
	onComplete={handleBatchComplete}
/>

{#if errorDialogData}
	<ErrorDialog
		open={true}
		title={errorDialogData.title}
		message={errorDialogData.message}
		onClose={() => errorDialogData = null}
	/>
{/if}
