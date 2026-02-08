<script lang="ts">
	import { onMount, onDestroy, untrack } from 'svelte';
	import * as Select from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import { DatePicker } from '$lib/components/ui/date-picker';
	import { Badge } from '$lib/components/ui/badge';
	import * as Dialog from '$lib/components/ui/dialog';
	import {
		RefreshCw,
		Download,
		FileJson,
		FileSpreadsheet,
		FileText,
		Calendar,
		User,
		Box,
		Layers,
		HardDrive,
		Network,
		Image,
		Settings,
		GitBranch,
		Key,
		Filter,
		X,
		Info,
		Crown,
		Server,
		Database,
		Shield,
		Plus,
		Pencil,
		Trash2,
		Play,
		Square,
		RotateCcw,
		Pause,
		CirclePlay,
		ArrowDownToLine,
		ArrowUpFromLine,
		Scissors,
		Terminal,
		Link,
		Unlink,
		LogIn,
		LogOut,
		GitPullRequest,
		Activity,
		Loader2,
		Wifi,
		FileX
	} from 'lucide-svelte';
	import { licenseStore } from '$lib/stores/license';
	import { getIconComponent } from '$lib/utils/icons';
	import {
		auditSseConnected,
		connectAuditSSE,
		disconnectAuditSSE,
		onAuditEvent,
		type AuditLogEntry as SSEAuditLogEntry
	} from '$lib/stores/audit-events';
	import { formatDateTime } from '$lib/stores/settings';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { DataGrid } from '$lib/components/data-grid';
	import DiffViewer from '$lib/components/DiffViewer.svelte';
	import type { AuditDiff } from '$lib/utils/diff';

	interface AuditLogEntry {
		id: number;
		userId: number | null;
		username: string;
		action: string;
		entityType: string;
		entityId: string | null;
		entityName: string | null;
		environmentId: number | null;
		environmentName: string | null;
		environmentIcon: string | null;
		description: string | null;
		details: any | null;
		ipAddress: string | null;
		userAgent: string | null;
		createdAt: string;
	}

	interface Environment {
		id: number;
		name: string;
		icon: string;
	}

	// Constants
	const FETCH_BATCH_SIZE = 100;

	// State
	let logs = $state<AuditLogEntry[]>([]);
	let logIds = $state<Set<number>>(new Set());
	let total = $state(0);
	let loading = $state(false);
	let loadingMore = $state(false);
	let users = $state<string[]>([]);
	let environments = $state<Environment[]>([]);
	let hasMore = $state(true);
	let initialized = $state(false);
	let dataFetched = $state(false);

	// Visible range for DataGrid
	let visibleStart = $state(1);
	let visibleEnd = $state(0);

	// localStorage key for filters
	const STORAGE_KEY = 'dockhand_audit_filters';

	// Filters
	let filterUsernames = $state<string[]>([]);
	let filterEntityTypes = $state<string[]>([]);
	let filterActions = $state<string[]>([]);
	let filterEnvironmentId = $state<number | null>(null);
	let filterFromDate = $state('');
	let filterToDate = $state('');

	// Load filters from localStorage
	function loadFiltersFromStorage() {
		if (typeof window === 'undefined') return;
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			if (stored) {
				const parsed = JSON.parse(stored);
				filterUsernames = parsed.usernames || [];
				filterEntityTypes = parsed.entityTypes || [];
				filterActions = parsed.actions || [];
				filterEnvironmentId = parsed.environmentId || null;
				filterFromDate = parsed.fromDate || '';
				filterToDate = parsed.toDate || '';
			}
		} catch (e) {
			console.error('Failed to load audit filters from localStorage:', e);
		}
	}

	// Save filters to localStorage
	function saveFiltersToStorage() {
		if (typeof window === 'undefined') return;
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify({
				usernames: filterUsernames,
				entityTypes: filterEntityTypes,
				actions: filterActions,
				environmentId: filterEnvironmentId,
				fromDate: filterFromDate,
				toDate: filterToDate
			}));
		} catch (e) {
			console.error('Failed to save audit filters to localStorage:', e);
		}
	}

	// Detail dialog
	let showDetailDialog = $state(false);
	let selectedLog = $state<AuditLogEntry | null>(null);

	// Export dropdown
	let showExportMenu = $state(false);

	const entityTypes = [
		{ value: 'container', label: 'Containers' },
		{ value: 'image', label: 'Images' },
		{ value: 'volume', label: 'Volumes' },
		{ value: 'network', label: 'Networks' },
		{ value: 'stack', label: 'Stacks' },
		{ value: 'environment', label: 'Environments' },
		{ value: 'registry', label: 'Registries' },
		{ value: 'user', label: 'Users' },
		{ value: 'role', label: 'Roles' },
		{ value: 'settings', label: 'Settings' },
		{ value: 'git_repository', label: 'Git repositories' },
		{ value: 'git_credential', label: 'Git credentials' }
	];

	const actionTypes = [
		{ value: 'create', label: 'Create' },
		{ value: 'update', label: 'Update' },
		{ value: 'delete', label: 'Delete' },
		{ value: 'start', label: 'Start' },
		{ value: 'stop', label: 'Stop' },
		{ value: 'restart', label: 'Restart' },
		{ value: 'pause', label: 'Pause' },
		{ value: 'unpause', label: 'Unpause' },
		{ value: 'pull', label: 'Pull' },
		{ value: 'push', label: 'Push' },
		{ value: 'prune', label: 'Prune' },
		{ value: 'exec', label: 'Exec' },
		{ value: 'connect', label: 'Connect' },
		{ value: 'disconnect', label: 'Disconnect' },
		{ value: 'login', label: 'Login' },
		{ value: 'logout', label: 'Logout' },
		{ value: 'sync', label: 'Sync' }
	];

	// Date filter preset
	let selectedDatePreset = $state<string>('');

	// Check if any filters are active
	const hasActiveFilters = $derived(
		filterUsernames.length > 0 || filterEntityTypes.length > 0 || filterActions.length > 0 ||
		filterEnvironmentId !== null || selectedDatePreset
	);

	const datePresets = [
		{ value: 'today', label: 'Today' },
		{ value: 'yesterday', label: 'Yesterday' },
		{ value: 'last7days', label: 'Last 7 days' },
		{ value: 'last30days', label: 'Last 30 days' },
		{ value: 'thisMonth', label: 'This month' },
		{ value: 'lastMonth', label: 'Last month' }
	];

	function formatDateForInput(date: Date): string {
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, '0');
		const day = String(date.getDate()).padStart(2, '0');
		return `${year}-${month}-${day}`;
	}

	function applyDatePreset(preset: string): { from: string; to: string } {
		const today = new Date();
		today.setHours(0, 0, 0, 0);

		let from = '';
		let to = '';

		switch (preset) {
			case 'today':
				from = formatDateForInput(today);
				to = formatDateForInput(today);
				break;
			case 'yesterday': {
				const yesterday = new Date(today);
				yesterday.setDate(yesterday.getDate() - 1);
				from = formatDateForInput(yesterday);
				to = formatDateForInput(yesterday);
				break;
			}
			case 'last7days': {
				const weekAgo = new Date(today);
				weekAgo.setDate(weekAgo.getDate() - 6);
				from = formatDateForInput(weekAgo);
				to = formatDateForInput(today);
				break;
			}
			case 'last30days': {
				const monthAgo = new Date(today);
				monthAgo.setDate(monthAgo.getDate() - 29);
				from = formatDateForInput(monthAgo);
				to = formatDateForInput(today);
				break;
			}
			case 'thisMonth': {
				const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
				from = formatDateForInput(firstOfMonth);
				to = formatDateForInput(today);
				break;
			}
			case 'lastMonth': {
				const firstOfLastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
				const lastOfLastMonth = new Date(today.getFullYear(), today.getMonth(), 0);
				from = formatDateForInput(firstOfLastMonth);
				to = formatDateForInput(lastOfLastMonth);
				break;
			}
		}

		filterFromDate = from;
		filterToDate = to;

		return { from, to };
	}

	let fetchController: AbortController | null = null;

	async function fetchLogs(append = false, silent = false) {
		if (!$licenseStore.isEnterprise) return;

		if (append && loadingMore) return;

		if (!append && fetchController) {
			fetchController.abort();
		}

		if (append) {
			loadingMore = true;
		} else if (!silent) {
			loading = true;
			hasMore = true;
		}

		fetchController = new AbortController();

		try {
			const params = new URLSearchParams();

			if (filterUsernames.length > 0) params.set('usernames', filterUsernames.join(','));
			if (filterEntityTypes.length > 0) params.set('entityTypes', filterEntityTypes.join(','));
			if (filterActions.length > 0) params.set('actions', filterActions.join(','));
			if (filterEnvironmentId !== null) params.set('environmentId', String(filterEnvironmentId));
			if (filterFromDate) params.set('fromDate', filterFromDate);
			if (filterToDate) params.set('toDate', filterToDate + 'T23:59:59');
			params.set('limit', String(FETCH_BATCH_SIZE));
			params.set('offset', String(append ? logs.length : 0));

			const response = await fetch(`/api/audit?${params.toString()}`, {
				signal: fetchController.signal
			});
			if (!response.ok) {
				throw new Error('Failed to fetch audit logs');
			}
			const data = await response.json();

			total = data.total;

			if (append) {
				logs.push(...data.logs);
				logs = logs;
				hasMore = logs.length < total;
				for (const log of data.logs) {
					logIds.add(log.id);
				}
			} else {
				logs = data.logs;
				hasMore = logs.length < total;
				logIds = new Set(data.logs.map((log: AuditLogEntry) => log.id));
			}
			dataFetched = true;

			loading = false;
			loadingMore = false;
			fetchController = null;
		} catch (error: any) {
			if (error?.name === 'AbortError') {
				return;
			}
			console.error('Failed to fetch audit logs:', error);
			if (!append && !silent) {
				logs = [];
				total = 0;
			}
			loading = false;
			loadingMore = false;
			fetchController = null;
			hasMore = false;
		}
	}

	async function fetchUsers() {
		if (!$licenseStore.isEnterprise) return;

		try {
			const response = await fetch('/api/audit/users');
			if (response.ok) {
				users = await response.json();
			}
		} catch (error) {
			console.error('Failed to fetch users:', error);
		}
	}

	async function fetchEnvironments() {
		try {
			const response = await fetch('/api/environments');
			if (response.ok) {
				environments = await response.json();
			}
		} catch (error) {
			console.error('Failed to fetch environments:', error);
		}
	}

	function clearFilters() {
		filterUsernames = [];
		filterEntityTypes = [];
		filterEnvironmentId = null;
		filterActions = [];
		filterFromDate = '';
		filterToDate = '';
		selectedDatePreset = '';
		if (typeof window !== 'undefined') {
			localStorage.removeItem(STORAGE_KEY);
		}
	}

	// Track if initial load is done
	let initialLoadDone = $state(false);

	// Auto-fetch when filters change
	$effect(() => {
		const _u = filterUsernames;
		const _e = filterEntityTypes;
		const _a = filterActions;
		const _fd = filterFromDate;
		const _td = filterToDate;

		const isReady = untrack(() => initialLoadDone);
		const isEnterprise = untrack(() => $licenseStore.isEnterprise);

		if (isReady && isEnterprise) {
			saveFiltersToStorage();
			fetchLogs(false);
		}
	});

	// Called by DataGrid when user scrolls near the bottom
	function loadMoreLogs() {
		if (hasMore && !loadingMore && !loading) {
			fetchLogs(true);
		}
	}

	// Called by DataGrid when visible range changes
	function handleVisibleRangeChange(start: number, end: number, _total: number) {
		visibleStart = start;
		visibleEnd = end;
	}

	function showDetails(log: AuditLogEntry) {
		selectedLog = log;
		showDetailDialog = true;
	}

	async function exportLogs(format: string) {
		showExportMenu = false;
		const params = new URLSearchParams();

		if (filterUsernames.length > 0) params.set('usernames', filterUsernames.join(','));
		if (filterEntityTypes.length > 0) params.set('entityTypes', filterEntityTypes.join(','));
		if (filterActions.length > 0) params.set('actions', filterActions.join(','));
		if (filterFromDate) params.set('fromDate', filterFromDate);
		if (filterToDate) params.set('toDate', filterToDate + 'T23:59:59');
		params.set('format', format);

		window.location.href = `/api/audit/export?${params.toString()}`;
	}

	function formatTimestamp(ts: string): string {
		return formatDateTime(ts, true);
	}

	function getEntityIcon(entityType: string) {
		switch (entityType) {
			case 'container': return Box;
			case 'image': return Image;
			case 'volume': return HardDrive;
			case 'network': return Network;
			case 'stack': return Layers;
			case 'user': return User;
			case 'role': return Shield;
			case 'settings': return Settings;
			case 'environment': return Server;
			case 'registry': return Database;
			case 'git_repository': return GitBranch;
			case 'git_credential': return Key;
			default: return Box;
		}
	}

	function getActionIcon(action: string) {
		switch (action) {
			case 'create': return Plus;
			case 'update': return Pencil;
			case 'delete': return Trash2;
			case 'start': return Play;
			case 'stop': return Square;
			case 'restart': return RotateCcw;
			case 'pause': return Pause;
			case 'unpause': return CirclePlay;
			case 'pull': return ArrowDownToLine;
			case 'push': return ArrowUpFromLine;
			case 'prune': return Scissors;
			case 'exec': return Terminal;
			case 'connect': return Link;
			case 'disconnect': return Unlink;
			case 'login': return LogIn;
			case 'logout': return LogOut;
			case 'sync': return GitPullRequest;
			default: return Activity;
		}
	}

	function getActionColor(action: string): string {
		switch (action) {
			case 'create':
			case 'start':
			case 'login':
				return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400';
			case 'delete':
			case 'stop':
			case 'logout':
				return 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400';
			case 'update':
			case 'restart':
				return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
			case 'pull':
			case 'push':
			case 'sync':
				return 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400';
			case 'exec':
			case 'connect':
			case 'disconnect':
				return 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400';
			default:
				return 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-400';
		}
	}

	// SSE event listener cleanup function
	let unsubscribeSSE: (() => void) | null = null;

	// Handle new audit events from SSE
	function handleNewAuditEvent(event: SSEAuditLogEntry) {
		// Check if event matches current filters
		if (filterUsernames.length > 0 && !filterUsernames.includes(event.username)) return;
		if (filterEntityTypes.length > 0 && !filterEntityTypes.includes(event.entityType)) return;
		if (filterActions.length > 0 && !filterActions.includes(event.action)) return;

		// Check date filters
		if (filterFromDate) {
			const eventDate = new Date(event.createdAt).toISOString().split('T')[0];
			if (eventDate < filterFromDate) return;
		}
		if (filterToDate) {
			const eventDate = new Date(event.createdAt).toISOString().split('T')[0];
			if (eventDate > filterToDate) return;
		}

		// Add to beginning of logs - use Set for fast duplicate check
		if (!logIds.has(event.id)) {
			logIds.add(event.id);
			logs.unshift(event as AuditLogEntry);
			logs = logs;
			total = total + 1;

			// Add user to list if not already there
			if (!users.includes(event.username)) {
				users = [...users, event.username].sort();
			}
		}
	}

	onMount(async () => {
		loadFiltersFromStorage();
		await fetchEnvironments();

		const licenseState = await licenseStore.waitUntilLoaded();

		if (licenseState.isEnterprise) {
			initialized = true;
			await fetchLogs();
			await fetchUsers();

			connectAuditSSE();
			unsubscribeSSE = onAuditEvent(handleNewAuditEvent);
		} else {
			initialized = true;
		}

		initialLoadDone = true;
	});

	onDestroy(() => {
		disconnectAuditSSE();
		if (unsubscribeSSE) {
			unsubscribeSSE();
			unsubscribeSSE = null;
		}
	});

	// Refetch when license changes
	$effect(() => {
		const isEnterprise = $licenseStore.isEnterprise;
		const fetched = untrack(() => dataFetched);
		const ready = untrack(() => initialLoadDone);
		const isLoading = untrack(() => loading);

		if (isEnterprise && !fetched && ready && !isLoading) {
			fetchLogs();
			fetchUsers();
		}
	});
</script>

<svelte:head>
	<title>Audit log - Dockhand</title>
</svelte:head>

<div class="flex-1 min-h-0 flex flex-col gap-3 overflow-hidden">
	<!-- Header -->
	<div class="shrink-0 flex flex-wrap justify-between items-center gap-3 min-h-8">
		<div class="flex items-center gap-3">
			<PageHeader icon={Crown} title="Audit log" iconClass="text-amber-500" count={visibleEnd > 0 ? `${visibleStart}-${visibleEnd}` : undefined} total={total > 0 ? total : undefined} countClass="min-w-32" />
		</div>
		{#if $licenseStore.isEnterprise}
			<div class="flex flex-wrap items-center gap-2">
				<!-- User filter (multi-select) -->
				<Select.Root type="multiple" bind:value={filterUsernames}>
					<Select.Trigger size="sm" class="w-32 text-sm">
						<User class="w-3.5 h-3.5 mr-1.5 text-muted-foreground shrink-0" />
						<span class="truncate">
							{#if filterUsernames.length === 0}
								User
							{:else if filterUsernames.length === 1}
								{filterUsernames[0]}
							{:else}
								{filterUsernames.length} users
							{/if}
						</span>
					</Select.Trigger>
					<Select.Content>
						{#if filterUsernames.length > 0}
							<button
								type="button"
								class="w-full px-2 py-1 text-xs text-left text-muted-foreground/60 hover:text-muted-foreground"
								onclick={() => filterUsernames = []}
							>
								Clear
							</button>
						{/if}
						{#each users as user}
							<Select.Item value={user}>
								<User class="w-4 h-4 mr-2 text-muted-foreground" />
								{user}
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>

				<!-- Entity type filter (multi-select) -->
				<Select.Root type="multiple" bind:value={filterEntityTypes}>
					<Select.Trigger size="sm" class="w-32 text-sm">
						<Box class="w-3.5 h-3.5 mr-1.5 text-muted-foreground shrink-0" />
						<span class="truncate">
							{#if filterEntityTypes.length === 0}
								Entity
							{:else if filterEntityTypes.length === 1}
								{entityTypes.find(e => e.value === filterEntityTypes[0])?.label || filterEntityTypes[0]}
							{:else}
								{filterEntityTypes.length} entities
							{/if}
						</span>
					</Select.Trigger>
					<Select.Content>
						{#if filterEntityTypes.length > 0}
							<button
								type="button"
								class="w-full px-2 py-1 text-xs text-left text-muted-foreground/60 hover:text-muted-foreground"
								onclick={() => filterEntityTypes = []}
							>
								Clear
							</button>
						{/if}
						{#each entityTypes as type}
							<Select.Item value={type.value}>
								<svelte:component this={getEntityIcon(type.value)} class="w-4 h-4 mr-2 text-muted-foreground" />
								{type.label}
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>

				<!-- Action filter (multi-select) -->
				<Select.Root type="multiple" bind:value={filterActions}>
					<Select.Trigger size="sm" class="w-32 text-sm">
						<Activity class="w-3.5 h-3.5 mr-1.5 text-muted-foreground shrink-0" />
						<span class="truncate">
							{#if filterActions.length === 0}
								Action
							{:else if filterActions.length === 1}
								{actionTypes.find(a => a.value === filterActions[0])?.label || filterActions[0]}
							{:else}
								{filterActions.length} actions
							{/if}
						</span>
					</Select.Trigger>
					<Select.Content>
						{#if filterActions.length > 0}
							<button
								type="button"
								class="w-full px-2 py-1 text-xs text-left text-muted-foreground/60 hover:text-muted-foreground"
								onclick={() => filterActions = []}
							>
								Clear
							</button>
						{/if}
						{#each actionTypes as action}
							<Select.Item value={action.value}>
								<svelte:component this={getActionIcon(action.value)} class="w-4 h-4 mr-2 text-muted-foreground" />
								{action.label}
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>

				<!-- Environment filter -->
				{#if environments.length > 0}
					{@const selectedEnv = environments.find(e => e.id === filterEnvironmentId)}
					{@const SelectedEnvIcon = selectedEnv ? getIconComponent(selectedEnv.icon || 'globe') : Server}
					<Select.Root
						type="single"
						value={filterEnvironmentId !== null ? String(filterEnvironmentId) : undefined}
						onValueChange={(v) => filterEnvironmentId = v ? parseInt(v) : null}
					>
						<Select.Trigger size="sm" class="w-40 text-sm">
							<SelectedEnvIcon class="w-3.5 h-3.5 mr-1.5 text-muted-foreground shrink-0" />
							<span class="truncate">
								{#if filterEnvironmentId === null}
									Environment
								{:else}
									{selectedEnv?.name || 'Environment'}
								{/if}
							</span>
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="">
								<Server class="w-4 h-4 mr-2 text-muted-foreground" />
								All environments
							</Select.Item>
							{#each environments as env}
								{@const EnvIcon = getIconComponent(env.icon || 'globe')}
								<Select.Item value={String(env.id)}>
									<EnvIcon class="w-4 h-4 mr-2 text-muted-foreground" />
									{env.name}
								</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				{/if}

				<!-- Date range filter -->
				<Select.Root
					type="single"
					value={selectedDatePreset}
					onValueChange={(v) => {
						selectedDatePreset = v || '';
						if (v !== 'custom') {
							applyDatePreset(v || '');
						}
					}}
				>
					<Select.Trigger size="sm" class="w-32 text-sm">
						<Calendar class="w-3.5 h-3.5 mr-1.5 text-muted-foreground shrink-0" />
						<span class="truncate">
							{#if selectedDatePreset === 'custom'}
								Custom
							{:else if selectedDatePreset}
								{datePresets.find(d => d.value === selectedDatePreset)?.label || 'All time'}
							{:else}
								All time
							{/if}
						</span>
					</Select.Trigger>
					<Select.Content>
						<Select.Item value="">All time</Select.Item>
						{#each datePresets as preset}
							<Select.Item value={preset.value}>{preset.label}</Select.Item>
						{/each}
						<Select.Item value="custom">Custom range...</Select.Item>
					</Select.Content>
				</Select.Root>

				<!-- Custom date inputs -->
				{#if selectedDatePreset === 'custom'}
					<DatePicker bind:value={filterFromDate} placeholder="From" class="h-8 w-28" />
					<DatePicker bind:value={filterToDate} placeholder="To" class="h-8 w-28" />
				{/if}

				<!-- Clear filters -->
				<Button
					variant="outline"
					size="sm"
					class="h-8 px-2"
					onclick={clearFilters}
					disabled={!hasActiveFilters}
					title="Clear all filters"
				>
					<X class="w-3.5 h-3.5" />
				</Button>

				<!-- Live indicator -->
				<span
					class="flex items-center gap-1.5 text-xs {$auditSseConnected ? 'text-emerald-500' : 'text-muted-foreground'}"
					title={$auditSseConnected ? 'Live updates active' : 'Connecting...'}
				>
					<Wifi class="w-3.5 h-3.5" />
				</span>

				<Button variant="outline" size="sm" onclick={() => { hasMore = true; fetchLogs(false); }} disabled={loading}>
					<RefreshCw class="w-3.5 h-3.5 {loading ? 'animate-spin' : ''}" />
				</Button>

				<div class="relative">
					<Button variant="outline" size="sm" onclick={() => showExportMenu = !showExportMenu}>
						<Download class="w-3.5 h-3.5" />
					</Button>
					{#if showExportMenu}
						<div class="absolute right-0 mt-1 w-40 bg-popover border rounded-md shadow-lg z-50">
							<button
								type="button"
								class="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-accent"
								onclick={() => exportLogs('json')}
							>
								<FileJson class="w-4 h-4" />
								JSON
							</button>
							<button
								type="button"
								class="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-accent"
								onclick={() => exportLogs('csv')}
							>
								<FileSpreadsheet class="w-4 h-4" />
								CSV
							</button>
							<button
								type="button"
								class="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-accent"
								onclick={() => exportLogs('md')}
							>
								<FileText class="w-4 h-4" />
								Markdown
							</button>
						</div>
					{/if}
				</div>
			</div>
		{/if}
	</div>

	{#if $licenseStore.loading}
		<div class="flex flex-col items-center justify-center py-16 text-center">
			<Loader2 class="w-8 h-8 animate-spin text-muted-foreground mb-4" />
			<p class="text-muted-foreground">Loading...</p>
		</div>
	{:else if !$licenseStore.isEnterprise}
		<div class="flex flex-col items-center justify-center py-16 text-center">
			<div class="w-16 h-16 rounded-full bg-amber-500/10 flex items-center justify-center mb-4">
				<Crown class="w-8 h-8 text-amber-500" />
			</div>
			<h2 class="text-xl font-semibold mb-2">Enterprise feature</h2>
			<p class="text-muted-foreground max-w-md mb-6">
				Audit logging is an enterprise feature that tracks all user actions for compliance and security monitoring.
			</p>
			<Button variant="outline" href="/settings?tab=license">
				<Key class="w-4 h-4" />
				Activate license
			</Button>
		</div>
	{:else}
		<DataGrid
			data={logs}
			keyField="id"
			gridId="audit"
			virtualScroll
			hasMore={hasMore}
			onLoadMore={loadMoreLogs}
			onVisibleRangeChange={handleVisibleRangeChange}
			loading={loading || !initialized}
			onRowClick={(log) => showDetails(log)}
			class="border-none"
			wrapperClass="border rounded-lg"
		>
			{#snippet cell(column, log, rowState)}
				{#if column.id === 'timestamp'}
					<span class="font-mono text-xs whitespace-nowrap">{formatTimestamp(log.createdAt)}</span>
				{:else if column.id === 'environment'}
					{#if log.environmentName}
						{@const LogEnvIcon = getIconComponent(log.environmentIcon || 'globe')}
						<div class="flex items-center gap-1 text-xs">
							<LogEnvIcon class="w-3 h-3 text-muted-foreground shrink-0" />
							<span class="truncate">{log.environmentName}</span>
						</div>
					{:else}
						<span class="text-muted-foreground text-xs">-</span>
					{/if}
				{:else if column.id === 'user'}
					<div class="flex items-center gap-1 text-xs">
						<User class="w-3 h-3 text-muted-foreground shrink-0" />
						<span class="truncate">{log.username}</span>
					</div>
				{:else if column.id === 'action'}
					<div class="flex justify-center">
						<Badge class="{getActionColor(log.action)} py-0.5 px-1" title={log.action.charAt(0).toUpperCase() + log.action.slice(1)}>
							<svelte:component this={getActionIcon(log.action)} class="w-3 h-3" />
						</Badge>
					</div>
				{:else if column.id === 'entity'}
					<div class="flex items-center gap-1 text-xs">
						<svelte:component this={getEntityIcon(log.entityType)} class="w-3 h-3 text-muted-foreground shrink-0" />
						<span class="truncate">{log.entityType}</span>
					</div>
				{:else if column.id === 'name'}
					<span class="text-xs truncate" title={log.entityName || log.entityId || '-'}>
						{log.entityName || log.entityId || '-'}
					</span>
				{:else if column.id === 'ip'}
					<span class="font-mono text-xs text-muted-foreground">
						{log.ipAddress || '-'}
					</span>
				{:else if column.id === 'actions'}
					<div class="flex items-center justify-end">
						<Button variant="ghost" size="icon" class="h-6 w-6" onclick={(e) => { e.stopPropagation(); showDetails(log); }}>
							<Info class="w-3.5 h-3.5" />
						</Button>
					</div>
				{/if}
			{/snippet}

			{#snippet emptyState()}
				<div class="flex flex-col items-center justify-center py-16 text-muted-foreground">
					<FileX class="w-10 h-10 mb-3 opacity-40" />
					<p>No audit log entries found</p>
				</div>
			{/snippet}

			{#snippet loadingState()}
				<div class="flex items-center justify-center py-16 text-muted-foreground">
					<RefreshCw class="w-5 h-5 animate-spin mr-2" />
					Loading...
				</div>
			{/snippet}

			{#snippet footer()}
				{#if loadingMore}
					<div class="flex items-center justify-center py-2 text-muted-foreground">
						<Loader2 class="w-4 h-4 animate-spin mr-2" />
						Loading more...
					</div>
				{:else if !hasMore && logs.length > 0}
					<div class="text-center py-2 text-sm text-muted-foreground">
						End of results ({total.toLocaleString()} entries)
					</div>
				{/if}
			{/snippet}
		</DataGrid>
	{/if}
</div>

<!-- Detail Dialog -->
<Dialog.Root bind:open={showDetailDialog}>
	<Dialog.Content class="max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Audit log details</Dialog.Title>
		</Dialog.Header>
		{#if selectedLog}
			<div class="space-y-4">
				<div class="grid grid-cols-2 gap-4">
					<div>
						<label class="text-sm font-medium text-muted-foreground">Timestamp</label>
						<p class="font-mono text-sm">{formatTimestamp(selectedLog.createdAt)}</p>
					</div>
					<div>
						<label class="text-sm font-medium text-muted-foreground">User</label>
						<p class="flex items-center gap-1">
							<User class="w-4 h-4 text-muted-foreground" />
							{selectedLog.username}
						</p>
					</div>
					<div>
						<label class="text-sm font-medium text-muted-foreground">Action</label>
						<p>
							<Badge class="{getActionColor(selectedLog.action)} gap-1">
								<svelte:component this={getActionIcon(selectedLog.action)} class="w-3 h-3" />
								{selectedLog.action}
							</Badge>
						</p>
					</div>
					<div>
						<label class="text-sm font-medium text-muted-foreground">Entity type</label>
						<p class="flex items-center gap-1">
							<svelte:component this={getEntityIcon(selectedLog.entityType)} class="w-4 h-4 text-muted-foreground" />
							{selectedLog.entityType}
						</p>
					</div>
					{#if selectedLog.entityName}
						<div>
							<label class="text-sm font-medium text-muted-foreground">Entity name</label>
							<p>{selectedLog.entityName}</p>
						</div>
					{/if}
					{#if selectedLog.entityId}
						<div>
							<label class="text-sm font-medium text-muted-foreground">Entity ID</label>
							<p class="font-mono text-sm break-all">{selectedLog.entityId}</p>
						</div>
					{/if}
					{#if selectedLog.environmentId}
						<div>
							<label class="text-sm font-medium text-muted-foreground">Environment ID</label>
							<p>{selectedLog.environmentId}</p>
						</div>
					{/if}
					{#if selectedLog.ipAddress}
						<div>
							<label class="text-sm font-medium text-muted-foreground">IP address</label>
							<p class="font-mono text-sm">{selectedLog.ipAddress}</p>
						</div>
					{/if}
				</div>

				{#if selectedLog.description}
					<div>
						<label class="text-sm font-medium text-muted-foreground">Description</label>
						<p>{selectedLog.description}</p>
					</div>
				{/if}

				{#if selectedLog.userAgent}
					<div>
						<label class="text-sm font-medium text-muted-foreground">User agent</label>
						<p class="text-xs text-muted-foreground break-all">{selectedLog.userAgent}</p>
					</div>
				{/if}

				{#if selectedLog.details?.changes}
					<div>
						<label class="text-sm font-medium text-muted-foreground mb-2 block">Changes</label>
						<DiffViewer diff={selectedLog.details as AuditDiff} />
					</div>
				{:else if selectedLog.details}
					<div>
						<label class="text-sm font-medium text-muted-foreground">Details</label>
						<pre class="mt-1 p-3 bg-muted rounded-md text-xs overflow-auto max-h-[200px]">{JSON.stringify(selectedLog.details, null, 2)}</pre>
					</div>
				{/if}
			</div>
		{/if}
		<Dialog.Footer>
			<Button variant="outline" onclick={() => showDetailDialog = false}>Close</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Click outside to close export menu -->
{#if showExportMenu}
	<button
		type="button"
		class="fixed inset-0 z-40"
		onclick={() => showExportMenu = false}
		aria-label="Close menu"
	></button>
{/if}
