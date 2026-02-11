<script lang="ts">
	import { onMount, onDestroy, untrack } from 'svelte';
	import { page } from '$app/stores';
	import * as Select from '$lib/components/ui/select';
	import MultiSelectFilter from '$lib/components/MultiSelectFilter.svelte';
	import { Button } from '$lib/components/ui/button';
	import { DatePicker } from '$lib/components/ui/date-picker';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import * as Dialog from '$lib/components/ui/dialog';
	import {
		RefreshCw,
		Calendar,
		Box,
		X,
		Eye,
		Server,
		Play,
		Square,
		RotateCcw,
		Pause,
		CirclePlay,
		Trash2,
		Plus,
		Skull,
		Zap,
		AlertTriangle,
		Pencil,
		Activity,
		Loader2,
		FileX,
		Heart,
		Search,
		Wifi,
		Radio
	} from 'lucide-svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { currentEnvironment, environments as environmentsStore } from '$lib/stores/environment';
	import { getIconComponent } from '$lib/utils/icons';
	import { canAccess } from '$lib/stores/auth';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import { toast } from 'svelte-sonner';
	import { formatDateTime, appSettings } from '$lib/stores/settings';
	import { NoEnvironment } from '$lib/components/ui/empty-state';
	import { DataGrid } from '$lib/components/data-grid';

	interface ContainerEvent {
		id: number;
		environmentId: number | null;
		environmentName: string | null;
		environmentIcon: string | null;
		containerId: string | null;
		containerName: string | null;
		image: string | null;
		action: string;
		actorAttributes: Record<string, string> | null;
		timestamp: string;
		createdAt: string;
	}

	interface Environment {
		id: number;
		name: string;
		icon: string;
		labels?: string[];
	}

	// Constants
	const FETCH_BATCH_SIZE = 100;

	// State
	let events = $state<ContainerEvent[]>([]);
	let eventIds = $state<Set<number>>(new Set()); // Fast duplicate check
	let total = $state(0);
	let loading = $state(false);
	let loadingMore = $state(false);
	let containers = $state<string[]>([]);
	let environments = $state<Environment[]>([]);
	let envId = $state<number | null>(null);
	let hasMore = $state(true);
	let initialized = $state(false);
	let dataFetched = $state(false);
	let showClearConfirm = $state(false);
	let clearingActivity = $state(false);

	// Visible range for virtual scroll
	let visibleStart = $state(1);
	let visibleEnd = $state(0);

	// localStorage key for filters
	const STORAGE_KEY = 'dockhand_activity_filters';

	// Filters
	let filterContainerName = $state('');
	let filterActions = $state<string[]>([]);
	let filterEnvironmentId = $state<number | null>(null);
	let filterLabels = $state<string[]>([]);
	let filterFromDate = $state('');
	let filterToDate = $state('');

	// Load filters from localStorage
	function loadFiltersFromStorage() {
		if (typeof window === 'undefined') return;
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			if (stored) {
				const parsed = JSON.parse(stored);
				filterContainerName = parsed.containerName || '';
				filterActions = parsed.actions || [];
				filterEnvironmentId = parsed.environmentId || null;
				filterLabels = parsed.labels || [];
				filterFromDate = parsed.fromDate || '';
				filterToDate = parsed.toDate || '';
			}
		} catch (e) {
			console.error('Failed to load activity filters from localStorage:', e);
		}
	}

	// Save filters to localStorage
	function saveFiltersToStorage() {
		if (typeof window === 'undefined') return;
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify({
				containerName: filterContainerName,
				actions: filterActions,
				environmentId: filterEnvironmentId,
				labels: filterLabels,
				fromDate: filterFromDate,
				toDate: filterToDate
			}));
		} catch (e) {
			console.error('Failed to save activity filters to localStorage:', e);
		}
	}

	// Detail dialog
	let showDetailDialog = $state(false);
	let selectedEvent = $state<ContainerEvent | null>(null);

	// SSE connection
	let sseConnected = $state(false);
	let eventSource: EventSource | null = null;

	const actionOptions = [
		{ value: 'create', label: 'Create', icon: Plus, color: 'text-emerald-500' },
		{ value: 'start', label: 'Start', icon: Play, color: 'text-emerald-500' },
		{ value: 'stop', label: 'Stop', icon: Square, color: 'text-amber-500' },
		{ value: 'die', label: 'Die', icon: Skull, color: 'text-red-500' },
		{ value: 'kill', label: 'Kill', icon: Zap, color: 'text-red-500' },
		{ value: 'restart', label: 'Restart', icon: RotateCcw, color: 'text-sky-500' },
		{ value: 'pause', label: 'Pause', icon: Pause, color: 'text-amber-500' },
		{ value: 'unpause', label: 'Unpause', icon: CirclePlay, color: 'text-emerald-500' },
		{ value: 'destroy', label: 'Destroy', icon: Trash2, color: 'text-red-500' },
		{ value: 'rename', label: 'Rename', icon: Pencil, color: 'text-muted-foreground' },
		{ value: 'update', label: 'Update', icon: Pencil, color: 'text-sky-500' },
		{ value: 'oom', label: 'Out of memory', icon: AlertTriangle, color: 'text-red-500' },
		{ value: 'health_status', label: 'Health status', icon: Heart, color: 'text-amber-500' }
	];

	// Date filter preset
	let selectedDatePreset = $state<string>('');

	// Check if any filters are active
	const hasActiveFilters = $derived(
		filterContainerName || filterActions.length > 0 || filterEnvironmentId !== null || selectedDatePreset
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

	async function clearActivity() {
		clearingActivity = true;
		try {
			const res = await fetch('/api/activity', {
				method: 'DELETE'
			});
			if (!res.ok) {
				const data = await res.json();
				throw new Error(data.error || 'Failed to clear activity');
			}
			toast.success('Activity log cleared');
			// Reset and reload
			events = [];
			eventIds = new Set();
			total = 0;
			hasMore = true;
			fetchEvents(false);
		} catch (error: any) {
			toast.error(error.message);
		} finally {
			clearingActivity = false;
			showClearConfirm = false;
		}
	}

	// Subscribe to environment
	$effect(() => {
		const env = $currentEnvironment;
		envId = env?.id ?? null;
	});

	let fetchController: AbortController | null = null;

	async function fetchEvents(append = false, silent = false) {
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

			if (filterContainerName) params.set('containerName', filterContainerName);
			if (filterActions.length > 0) params.set('actions', filterActions.join(','));
			if (filterEnvironmentId !== null) params.set('environmentId', String(filterEnvironmentId));
			if (filterLabels.length > 0) params.set('labels', filterLabels.join(','));
			if (filterFromDate) params.set('fromDate', filterFromDate);
			if (filterToDate) params.set('toDate', filterToDate + 'T23:59:59');
			params.set('limit', String(FETCH_BATCH_SIZE));
			params.set('offset', String(append ? events.length : 0));

			const response = await fetch(`/api/activity?${params.toString()}`, {
				signal: fetchController.signal
			});
			if (!response.ok) {
				throw new Error('Failed to fetch events');
			}
			const data = await response.json();

			// Update total first so hasMore calculation is correct
			total = data.total;

			if (append) {
				// Use push() for O(k) append instead of spread for O(n) copy
				events.push(...data.events);
				events = events; // Trigger Svelte reactivity
				hasMore = events.length < total;
				// Update eventIds Set with new events
				for (const evt of data.events) {
					eventIds.add(evt.id);
				}
			} else {
				events = data.events;
				hasMore = events.length < total;
				// Reset eventIds Set
				eventIds = new Set(data.events.map((evt: ContainerEvent) => evt.id));
			}
			dataFetched = true;

			loading = false;
			loadingMore = false;
			fetchController = null;
		} catch (error: any) {
			if (error?.name === 'AbortError') {
				return;
			}
			console.error('Failed to fetch events:', error);
			if (!append && !silent) {
				events = [];
				total = 0;
			}
			loading = false;
			loadingMore = false;
			fetchController = null;
			hasMore = false;
		}
	}

	async function fetchContainers() {
		try {
			const params = new URLSearchParams();
			if (filterEnvironmentId !== null) {
				params.set('environmentId', String(filterEnvironmentId));
			}
			const response = await fetch(`/api/activity/containers?${params.toString()}`);
			if (response.ok) {
				containers = await response.json();
			}
		} catch (error) {
			console.error('Failed to fetch containers:', error);
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
		filterContainerName = '';
		filterActions = [];
		filterEnvironmentId = null;
		filterLabels = [];
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
		const _cn = filterContainerName;
		const _a = filterActions;
		const _fd = filterFromDate;
		const _td = filterToDate;
		const _ei = filterEnvironmentId;
		const _l = filterLabels;

		const isReady = untrack(() => initialLoadDone);

		if (isReady) {
			saveFiltersToStorage();
			fetchEvents(false);
		}
	});

	// Called by DataGrid when user scrolls near the bottom
	function loadMoreEvents() {
		if (hasMore && !loadingMore && !loading) {
			fetchEvents(true);
		}
	}

	// Called by DataGrid when visible range changes
	function handleVisibleRangeChange(start: number, end: number, _total: number) {
		visibleStart = start;
		visibleEnd = end;
	}

	function showDetails(event: ContainerEvent) {
		selectedEvent = event;
		showDetailDialog = true;
	}

	function formatTimestamp(ts: string): string {
		return formatDateTime(ts, true);
	}

	function getActionIcon(action: string) {
		switch (action) {
			case 'create': return Plus;
			case 'start': return Play;
			case 'stop': return Square;
			case 'die': return Skull;
			case 'kill': return Zap;
			case 'restart': return RotateCcw;
			case 'pause': return Pause;
			case 'unpause': return CirclePlay;
			case 'destroy': return Trash2;
			case 'rename': return Pencil;
			case 'update': return Pencil;
			case 'oom': return AlertTriangle;
			case 'health_status': return Heart;
			default: return Activity;
		}
	}

	function getActionColor(action: string): string {
		switch (action) {
			case 'create':
			case 'start':
			case 'unpause':
				return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400';
			case 'stop':
			case 'die':
			case 'kill':
			case 'destroy':
			case 'oom':
				return 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400';
			case 'restart':
			case 'pause':
			case 'update':
			case 'rename':
				return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
			case 'health_status':
				return 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400';
			default:
				return 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-400';
		}
	}

	// SSE connection
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let wasConnected = false;
	let reconnectAttempts = 0;
	const MAX_RECONNECT_ATTEMPTS = 10;
	const BASE_RECONNECT_DELAY = 3000;

	function connectSSE() {
		if (eventSource) {
			eventSource.close();
		}

		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}

		eventSource = new EventSource('/api/activity/events');

		eventSource.addEventListener('connected', () => {
			const wasDisconnected = wasConnected && !sseConnected;
			sseConnected = true;
			wasConnected = true;
			reconnectAttempts = 0; // Reset backoff on successful connection

			// If we were previously connected and reconnected, fetch any missed events
			if (wasDisconnected) {
				fetchEvents(false, true); // silent fetch to catch up on missed events
			}
		});

		eventSource.addEventListener('activity', (e) => {
			try {
				const newEvent = JSON.parse(e.data);

				// Check if event matches current filters
				if (filterContainerName && !newEvent.containerName?.includes(filterContainerName)) return;
				if (filterActions.length > 0 && !filterActions.includes(newEvent.action)) return;
				if (filterEnvironmentId !== null && newEvent.environmentId !== filterEnvironmentId) return;

				// Check date filters
				if (filterFromDate) {
					const eventDate = new Date(newEvent.timestamp).toISOString().split('T')[0];
					if (eventDate < filterFromDate) return;
				}
				if (filterToDate) {
					const eventDate = new Date(newEvent.timestamp).toISOString().split('T')[0];
					if (eventDate > filterToDate) return;
				}

				// Add to beginning of events (prepend new events) - use Set for fast duplicate check
				if (!eventIds.has(newEvent.id)) {
					eventIds.add(newEvent.id);
					// Use unshift() for in-place mutation instead of spread for O(n) copy
					events.unshift(newEvent);
					events = events; // Trigger Svelte reactivity
					total = total + 1;

					// Add container to list if not already there
					if (newEvent.containerName && !containers.includes(newEvent.containerName)) {
						containers.push(newEvent.containerName);
						containers.sort();
						containers = containers; // Trigger Svelte reactivity
					}
				}
			} catch {
				// Ignore parse errors
			}
		});

		eventSource.addEventListener('heartbeat', () => {
			sseConnected = true;
		});

		eventSource.onerror = () => {
			sseConnected = false;
			// Exponential backoff reconnection
			if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
				const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts), 60000);
				reconnectAttempts++;
				reconnectTimer = setTimeout(() => {
					if (eventSource?.readyState === EventSource.CLOSED) {
						connectSSE();
					}
				}, delay);
			}
		};
	}

	function disconnectSSE() {
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		if (eventSource) {
			eventSource.close();
			eventSource = null;
			sseConnected = false;
		}
	}

	// Handle tab visibility changes (e.g., user switches back from another tab)
	function handleVisibilityChange() {
		if (document.visibilityState === 'visible') {
			// Tab became visible - check and restore connection

			// Clear any pending reconnection timer
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
				reconnectTimer = null;
			}

			// Reset reconnection counter for fresh attempts
			reconnectAttempts = 0;

			// Reconnect SSE if it's closed or in error state
			if (!eventSource || eventSource.readyState !== EventSource.OPEN) {
				connectSSE();
			}
		}
	}

	onMount(() => {
		// Listen for tab visibility changes to reconnect when user returns
		document.addEventListener('visibilitychange', handleVisibilityChange);
		// Chrome 77+ Page Lifecycle API - fires when frozen tab is resumed
		document.addEventListener('resume', handleVisibilityChange);

		loadFiltersFromStorage();

		// Check for URL query param (env) - takes priority over localStorage
		const urlEnvParam = $page.url.searchParams.get('env');
		if (urlEnvParam) {
			const envIdFromUrl = parseInt(urlEnvParam);
			if (!isNaN(envIdFromUrl)) {
				filterEnvironmentId = envIdFromUrl;
			}
		}

		// Initialize in order - set initialized=true AFTER data is fetched
		fetchEnvironments().then(() => {
			// Validate filterEnvironmentId - reset if it doesn't exist
			if (filterEnvironmentId !== null) {
				const envExists = environments.some(e => e.id === filterEnvironmentId);
				if (!envExists) {
					filterEnvironmentId = null;
					saveFiltersToStorage();
				}
			}
			return fetchEvents();
		}).then(() => {
			initialized = true;
			return fetchContainers();
		}).then(() => {
			connectSSE();
			initialLoadDone = true;
		});
		// Note: In Svelte 5, cleanup must be in onDestroy, not returned from onMount
	});

	onDestroy(() => {
		document.removeEventListener('visibilitychange', handleVisibilityChange);
		document.removeEventListener('resume', handleVisibilityChange);
		disconnectSSE();
	});
</script>

<svelte:head>
	<title>Activity - Dockhand</title>
</svelte:head>

<div class="flex-1 min-h-0 flex flex-col gap-3 overflow-hidden">
	<!-- Header with inline filters -->
	<div class="shrink-0 flex flex-wrap justify-between items-center gap-3 min-h-8">
		<div class="flex items-center gap-3">
			<PageHeader icon={Activity} title="Activity" count={visibleEnd > 0 ? `${visibleStart}-${visibleEnd}` : undefined} total={total > 0 ? total : undefined} countClass="min-w-32" />
			<Badge variant="outline" class="gap-1.5 {($appSettings.eventCollectionMode || 'stream') === 'stream' ? 'text-green-500 border-green-500/50' : 'text-amber-500 border-amber-500/50'}">
				{#if ($appSettings.eventCollectionMode || 'stream') === 'stream'}
					<Wifi class="w-3 h-3" />
					<span>Stream</span>
				{:else if ($appSettings.eventCollectionMode || 'stream') === 'poll'}
					<Radio class="w-3 h-3" />
					<span>Poll</span><span class="text-[10px] opacity-70">({($appSettings.eventPollInterval || 60000) / 1000}s)</span>
				{:else}
					<span class="text-muted-foreground">Off</span>
				{/if}
			</Badge>
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<!-- Container name search -->
			<div class="relative">
				<Search class="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
				<Input
					type="text"
					placeholder="Container..."
					bind:value={filterContainerName}
					onkeydown={(e) => e.key === 'Escape' && (filterContainerName = '')}
					class="pl-8 h-8 w-36 text-sm"
				/>
			</div>

			<!-- Action filter -->
			<MultiSelectFilter
				bind:value={filterActions}
				options={actionOptions}
				placeholder="Action"
				pluralLabel="actions"
				width="w-36"
				defaultIcon={Activity}
			/>

			<!-- Environment filter -->
			{#if environments.length > 0}
				{@const selectedEnv = environments.find(e => e.id === filterEnvironmentId)}
				{@const SelectedEnvIcon = selectedEnv ? getIconComponent(selectedEnv.icon || 'globe') : Server}
				<Select.Root
					type="single"
					value={filterEnvironmentId !== null ? String(filterEnvironmentId) : undefined}
					onValueChange={(v) => filterEnvironmentId = v ? parseInt(v) : null}
				>
					<Select.Trigger size="sm" class="w-44 text-sm">
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

			<Button variant="outline" size="sm" onclick={() => { hasMore = true; fetchEvents(false); }} disabled={loading}>
				<RefreshCw class="w-3.5 h-3.5 {loading ? 'animate-spin' : ''}" />
			</Button>

			{#if $canAccess('activity', 'delete')}
				<ConfirmPopover
					bind:open={showClearConfirm}
					action="Clear"
					itemType="activity log"
					title="Clear all"
					onConfirm={clearActivity}
					confirmText="Clear"
					variant="destructive"
					disabled={clearingActivity}
					onOpenChange={(open) => showClearConfirm = open}
					unstyled
				>
					{#snippet children({ open })}
						<Button variant="outline" size="sm" disabled={clearingActivity || total === 0}>
							<Trash2 class="w-3.5 h-3.5" />
						</Button>
					{/snippet}
				</ConfirmPopover>
			{/if}
		</div>
	</div>

	<!-- DataGrid with Virtual Scrolling -->
	{#if $environmentsStore.length === 0}
		<NoEnvironment />
	{:else}
		<DataGrid
			data={events}
			keyField="id"
			gridId="activity"
			virtualScroll
			hasMore={hasMore}
			onLoadMore={loadMoreEvents}
			onVisibleRangeChange={handleVisibleRangeChange}
			loading={loading || !initialized}
			onRowClick={(event) => showDetails(event)}
			class="border-none"
			wrapperClass="border rounded-lg"
		>
			{#snippet cell(column, event, rowState)}
				{#if column.id === 'timestamp'}
					<span class="font-mono text-xs whitespace-nowrap">{formatTimestamp(event.timestamp)}</span>
				{:else if column.id === 'environment'}
					{#if event.environmentName}
						{@const EventEnvIcon = getIconComponent(event.environmentIcon || 'globe')}
						<div class="flex items-center gap-1 text-xs">
							<EventEnvIcon class="w-3 h-3 text-muted-foreground shrink-0" />
							<span class="truncate">{event.environmentName}</span>
						</div>
					{:else}
						<span class="text-muted-foreground text-xs">-</span>
					{/if}
				{:else if column.id === 'action'}
					<div class="flex justify-center">
						<Badge class="{getActionColor(event.action)} py-0.5 px-1" title={event.action.charAt(0).toUpperCase() + event.action.slice(1)}>
							<svelte:component this={getActionIcon(event.action)} class="w-3 h-3" />
						</Badge>
					</div>
				{:else if column.id === 'container'}
					<div class="flex items-center gap-1 truncate text-xs">
						<Box class="w-3 h-3 text-muted-foreground shrink-0" />
						<span class="truncate" title={event.containerName || event.containerId || 'Unknown'}>
							{event.containerName || (event.containerId ? event.containerId.slice(0, 12) : 'Unknown')}
						</span>
					</div>
				{:else if column.id === 'image'}
					<span class="text-xs text-muted-foreground truncate" title={event.image || '-'}>
						{event.image || '-'}
					</span>
				{:else if column.id === 'exitCode'}
					{#if event.actorAttributes?.exitCode !== undefined}
						{@const exitCode = parseInt(event.actorAttributes.exitCode)}
						<span class="font-mono text-xs text-center block {exitCode === 0 ? 'text-green-600' : 'text-red-500'}">
							{exitCode}
						</span>
					{:else}
						<span class="text-muted-foreground text-xs text-center block">-</span>
					{/if}
				{:else if column.id === 'actions'}
					<div class="flex items-center justify-end">
						<Button variant="ghost" size="icon" class="h-6 w-6" onclick={(e) => { e.stopPropagation(); showDetails(event); }}>
							<Eye class="w-3.5 h-3.5" />
						</Button>
					</div>
				{/if}
			{/snippet}

			{#snippet emptyState()}
				<div class="flex flex-col items-center justify-center py-16 text-muted-foreground">
					<FileX class="w-10 h-10 mb-3 opacity-40" />
					<p>No container events found</p>
					<p class="text-xs mt-1">Events will appear here as containers start, stop, etc.</p>
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
				{:else if !hasMore && events.length > 0}
					<div class="text-center py-2 text-sm text-muted-foreground">
						End of results ({total.toLocaleString()} events)
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
			<Dialog.Title>Event details</Dialog.Title>
		</Dialog.Header>
		{#if selectedEvent}
			<div class="space-y-4">
				<div class="grid grid-cols-2 gap-4">
					<div>
						<label class="text-sm font-medium text-muted-foreground">Timestamp</label>
						<p class="font-mono text-sm">{formatTimestamp(selectedEvent.timestamp)}</p>
					</div>
					<div>
						<label class="text-sm font-medium text-muted-foreground">Action</label>
						<p>
							<Badge class="{getActionColor(selectedEvent.action)} gap-1">
								<svelte:component this={getActionIcon(selectedEvent.action)} class="w-3 h-3" />
								{selectedEvent.action}
							</Badge>
						</p>
					</div>
					<div>
						<label class="text-sm font-medium text-muted-foreground">Container name</label>
						<p class="flex items-center gap-1">
							<Box class="w-4 h-4 text-muted-foreground" />
							{selectedEvent.containerName || '-'}
						</p>
					</div>
					<div>
						<label class="text-sm font-medium text-muted-foreground">Container ID</label>
						<p class="font-mono text-sm break-all">{selectedEvent.containerId}</p>
					</div>
					{#if selectedEvent.image}
						<div class="col-span-2">
							<label class="text-sm font-medium text-muted-foreground">Image</label>
							<p class="font-mono text-sm break-all">{selectedEvent.image}</p>
						</div>
					{/if}
					{#if selectedEvent.environmentName}
						<div>
							<label class="text-sm font-medium text-muted-foreground">Environment</label>
							<p>{selectedEvent.environmentName}</p>
						</div>
					{/if}
				</div>

				{#if selectedEvent.actorAttributes && Object.keys(selectedEvent.actorAttributes).length > 0}
					<div>
						<label class="text-sm font-medium text-muted-foreground">Attributes</label>
						<div class="mt-1 border rounded-md overflow-hidden max-h-[200px] overflow-y-auto">
							<table class="w-full text-xs">
								<tbody>
									{#each Object.entries(selectedEvent.actorAttributes) as [key, value], i}
										<tr class="{i % 2 === 0 ? 'bg-muted/50' : 'bg-background'}">
											<td class="px-3 py-1.5 font-mono font-medium text-muted-foreground whitespace-nowrap align-top w-1/3">{key}</td>
											<td class="px-3 py-1.5 font-mono break-all">{value}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</div>
				{/if}
			</div>
		{/if}
		<Dialog.Footer>
			<Button variant="outline" onclick={() => showDetailDialog = false}>Close</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
