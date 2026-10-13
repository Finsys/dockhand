<script lang="ts">
	import { onMount, onDestroy, untrack } from 'svelte';
	import { page } from '$app/stores';
	import * as Select from '$lib/components/ui/select';
	import MultiSelectFilter from '$lib/components/MultiSelectFilter.svelte';
	import { Button } from '$lib/components/ui/button';
	import { DatePicker } from '$lib/components/ui/date-picker';
	import { SearchInput } from '$lib/components/ui/search-input';
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
		Wifi,
		Radio
	} from 'lucide-svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { currentEnvironment, environments as environmentsStore } from '$lib/stores/environment';
	import EnvironmentIcon from '$lib/components/EnvironmentIcon.svelte';
	import { canAccess } from '$lib/stores/auth';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import { toast } from 'svelte-sonner';
	import { formatDateTime, appSettings } from '$lib/stores/settings';
	import { currentDateInTimezone, dayBoundaryToUtcISO } from '$lib/utils/date-format';
	import { NoEnvironment } from '$lib/components/ui/empty-state';
	import { DataGrid } from '$lib/components/data-grid';
	import { m } from '$lib/paraglide/messages.js';

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
		{ value: 'create', label: m.activity_action_create(), icon: Plus, color: 'text-emerald-500' },
		{ value: 'start', label: m.activity_action_start(), icon: Play, color: 'text-emerald-500' },
		{ value: 'stop', label: m.activity_action_stop(), icon: Square, color: 'text-amber-500' },
		{ value: 'die', label: m.activity_action_die(), icon: Skull, color: 'text-red-500' },
		{ value: 'kill', label: m.activity_action_kill(), icon: Zap, color: 'text-red-500' },
		{ value: 'restart', label: m.activity_action_restart(), icon: RotateCcw, color: 'text-sky-500' },
		{ value: 'pause', label: m.activity_action_pause(), icon: Pause, color: 'text-amber-500' },
		{ value: 'unpause', label: m.activity_action_unpause(), icon: CirclePlay, color: 'text-emerald-500' },
		{ value: 'destroy', label: m.activity_action_destroy(), icon: Trash2, color: 'text-red-500' },
		{ value: 'rename', label: m.activity_action_rename(), icon: Pencil, color: 'text-muted-foreground' },
		{ value: 'update', label: m.activity_action_update(), icon: Pencil, color: 'text-sky-500' },
		{ value: 'oom', label: m.activity_action_oom(), icon: AlertTriangle, color: 'text-red-500' },
		{ value: 'health_status', label: m.activity_action_health_status(), icon: Heart, color: 'text-amber-500' }
	];

	// Date filter preset
	let selectedDatePreset = $state<string>('');

	// Check if any filters are active
	const hasActiveFilters = $derived(
		filterContainerName || filterActions.length > 0 || filterEnvironmentId !== null || selectedDatePreset
	);

	const datePresets = [
		{ value: 'today', label: m.activity_date_today() },
		{ value: 'yesterday', label: m.activity_date_yesterday() },
		{ value: 'last7days', label: m.activity_date_last_7_days() },
		{ value: 'last30days', label: m.activity_date_last_30_days() },
		{ value: 'thisMonth', label: m.activity_date_this_month() },
		{ value: 'lastMonth', label: m.activity_date_last_month() }
	];

	// Filter dates are calendar days in the configured display timezone (#1269).
	// Presets do their arithmetic on UTC-midnight tokens so the browser's own
	// timezone never leaks in; boundaries convert to UTC instants when querying.
	const filterTimezone = $derived($appSettings.defaultTimezone || undefined);

	function formatDateForInput(date: Date): string {
		const year = date.getUTCFullYear();
		const month = String(date.getUTCMonth() + 1).padStart(2, '0');
		const day = String(date.getUTCDate()).padStart(2, '0');
		return `${year}-${month}-${day}`;
	}

	function applyDatePreset(preset: string): { from: string; to: string } {
		const [y, m, d] = currentDateInTimezone(filterTimezone).split('-').map(Number);
		const today = new Date(Date.UTC(y, m - 1, d));

		let from = '';
		let to = '';

		switch (preset) {
			case 'today':
				from = formatDateForInput(today);
				to = formatDateForInput(today);
				break;
			case 'yesterday': {
				const yesterday = new Date(today);
				yesterday.setUTCDate(yesterday.getUTCDate() - 1);
				from = formatDateForInput(yesterday);
				to = formatDateForInput(yesterday);
				break;
			}
			case 'last7days': {
				const weekAgo = new Date(today);
				weekAgo.setUTCDate(weekAgo.getUTCDate() - 6);
				from = formatDateForInput(weekAgo);
				to = formatDateForInput(today);
				break;
			}
			case 'last30days': {
				const monthAgo = new Date(today);
				monthAgo.setUTCDate(monthAgo.getUTCDate() - 29);
				from = formatDateForInput(monthAgo);
				to = formatDateForInput(today);
				break;
			}
			case 'thisMonth': {
				const firstOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
				from = formatDateForInput(firstOfMonth);
				to = formatDateForInput(today);
				break;
			}
			case 'lastMonth': {
				const firstOfLastMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
				const lastOfLastMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
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
				throw new Error(data.error || m.activity_toast_clear_failed());
			}
			toast.success(m.activity_toast_cleared());
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
			// Convert configured-timezone day boundaries to UTC instants so they
			// compare correctly against UTC-stored timestamps (#1269)
			if (filterFromDate) params.set('fromDate', dayBoundaryToUtcISO(filterFromDate, filterTimezone, false));
			if (filterToDate) params.set('toDate', dayBoundaryToUtcISO(filterToDate, filterTimezone, true));
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

				// Check date filters - boundaries are days in the configured
				// timezone, compared as UTC instants (#1269)
				if (filterFromDate || filterToDate) {
					const eventTime = new Date(newEvent.timestamp).getTime();
					if (filterFromDate && eventTime < new Date(dayBoundaryToUtcISO(filterFromDate, filterTimezone, false)).getTime()) return;
					if (filterToDate && eventTime > new Date(dayBoundaryToUtcISO(filterToDate, filterTimezone, true)).getTime()) return;
				}

				// Add to beginning of events (prepend new events) - use Set for fast duplicate check
				if (!eventIds.has(newEvent.id)) {
					eventIds.add(newEvent.id);
					events = [newEvent, ...events];
					total = total + 1;

					// Add container to list if not already there
					if (newEvent.containerName && !containers.includes(newEvent.containerName)) {
						containers = [...containers, newEvent.containerName].sort();
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
		}).catch((err) => {
			console.error('[Activity] Init chain failed:', err);
			// Connect SSE anyway so live events still work
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
	<title>{m.nav_activity()} - Dockhand</title>
</svelte:head>

<div class="flex-1 min-h-0 flex flex-col gap-3 overflow-hidden">
	<!-- Header with inline filters -->
	<div class="shrink-0 flex flex-wrap justify-between items-center gap-3 min-h-8">
		<div class="flex items-center gap-3">
			<PageHeader icon={Activity} title={m.nav_activity()} count={visibleEnd > 0 ? `${visibleStart}-${visibleEnd}` : undefined} total={total > 0 ? total : undefined} countClass="min-w-32" />
			<Badge variant="outline" class="gap-1.5 {($appSettings.eventCollectionMode || 'stream') === 'stream' ? 'text-green-500 border-green-500/50' : 'text-amber-500 border-amber-500/50'}">
				{#if ($appSettings.eventCollectionMode || 'stream') === 'stream'}
					<Wifi class="w-3 h-3" />
					<span>{m.activity_mode_stream()}</span>
				{:else if ($appSettings.eventCollectionMode || 'stream') === 'poll'}
					<Radio class="w-3 h-3" />
					<span>{m.activity_mode_poll()}</span><span class="text-[10px] opacity-70">({($appSettings.eventPollInterval || 60000) / 1000}s)</span>
				{:else}
					<span class="text-muted-foreground">{m.activity_mode_off()}</span>
				{/if}
			</Badge>
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<!-- Container name search -->
			<SearchInput bind:value={filterContainerName} placeholder={m.activity_filter_container_placeholder()} class="h-8 w-36 text-sm" />

			<!-- Action filter -->
			<MultiSelectFilter
				bind:value={filterActions}
				options={actionOptions}
				placeholder={m.activity_filter_action()}
				pluralLabel={m.activity_filter_actions_plural()}
				width="w-36"
				defaultIcon={Activity}
			/>

			<!-- Environment filter -->
			{#if environments.length > 0}
				{@const selectedEnv = environments.find(e => e.id === filterEnvironmentId)}
				<Select.Root
					type="single"
					value={filterEnvironmentId !== null ? String(filterEnvironmentId) : undefined}
					onValueChange={(v) => filterEnvironmentId = v ? parseInt(v) : null}
				>
					<Select.Trigger size="sm" class="w-44 text-sm">
						{#if selectedEnv}
							<EnvironmentIcon icon={selectedEnv.icon || 'globe'} envId={selectedEnv.id} class="w-3.5 h-3.5 mr-1.5 text-muted-foreground shrink-0" />
						{:else}
							<Server class="w-3.5 h-3.5 mr-1.5 text-muted-foreground shrink-0" />
						{/if}
						<span class="truncate">
							{#if filterEnvironmentId === null}
								{m.activity_filter_environment()}
							{:else}
								{selectedEnv?.name || m.activity_filter_environment()}
							{/if}
						</span>
					</Select.Trigger>
					<Select.Content>
						<Select.Item value="">
							<Server class="w-4 h-4 mr-2 text-muted-foreground" />
							{m.activity_filter_all_environments()}
						</Select.Item>
						{#each environments as env}
							<Select.Item value={String(env.id)}>
								<EnvironmentIcon icon={env.icon || 'globe'} envId={env.id} class="w-4 h-4 mr-2 text-muted-foreground" />
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
				<Select.Trigger size="sm" class="w-44 text-sm">
					<Calendar class="w-3.5 h-3.5 mr-1.5 text-muted-foreground shrink-0" />
					<span class="truncate">
						{#if selectedDatePreset === 'custom'}
							{m.activity_date_custom()}
						{:else if selectedDatePreset}
							{datePresets.find(d => d.value === selectedDatePreset)?.label || m.activity_date_all_time()}
						{:else}
							{m.activity_date_all_time()}
						{/if}
					</span>
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="">{m.activity_date_all_time()}</Select.Item>
					{#each datePresets as preset}
						<Select.Item value={preset.value}>{preset.label}</Select.Item>
					{/each}
					<Select.Item value="custom">{m.activity_date_custom_range()}</Select.Item>
				</Select.Content>
			</Select.Root>

			<!-- Custom date inputs -->
			{#if selectedDatePreset === 'custom'}
				<DatePicker bind:value={filterFromDate} placeholder={m.activity_date_from()} class="h-8 w-28" />
				<DatePicker bind:value={filterToDate} placeholder={m.activity_date_to()} class="h-8 w-28" />
			{/if}

			<!-- Clear filters -->
			<Button
				variant="outline"
				size="sm"
				class="h-8 px-2"
				onclick={clearFilters}
				disabled={!hasActiveFilters}
				title={m.activity_clear_filters()}
			>
				<X class="w-3.5 h-3.5" />
			</Button>

			<Button variant="outline" size="sm" onclick={() => { hasMore = true; fetchEvents(false); }} disabled={loading}>
				<RefreshCw class="w-3.5 h-3.5 {loading ? 'animate-spin' : ''}" />
			</Button>

			{#if $canAccess('activity', 'delete')}
				<ConfirmPopover
					localized
					bind:open={showClearConfirm}
					action={m.activity_confirm_action_clear()}
					itemType={m.activity_item_activity_log()}
					title={m.activity_clear_all_title()}
					onConfirm={clearActivity}
					confirmText={m.activity_clear_confirm()}
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
						<div class="flex items-center gap-1 text-xs">
							<EnvironmentIcon icon={event.environmentIcon || 'globe'} envId={event.environmentId || 0} class="w-3 h-3 text-muted-foreground shrink-0" />
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
						<span class="truncate" title={event.containerName || event.containerId || m.activity_unknown()}>
							{event.containerName || (event.containerId ? event.containerId.slice(0, 12) : m.activity_unknown())}
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
							<Eye class="grid-action-icon grid-action-info" />
						</Button>
					</div>
				{/if}
			{/snippet}

			{#snippet emptyState()}
				<div class="flex flex-col items-center justify-center py-16 text-muted-foreground">
					<FileX class="w-10 h-10 mb-3 opacity-40" />
					<p>{m.activity_empty_title()}</p>
					<p class="text-xs mt-1">{m.activity_empty_hint()}</p>
				</div>
			{/snippet}

			{#snippet loadingState()}
				<div class="flex items-center justify-center py-16 text-muted-foreground">
					<RefreshCw class="w-5 h-5 animate-spin mr-2" />
					{m.activity_loading()}
				</div>
			{/snippet}
			{#snippet footer()}
				{#if loadingMore}
					<div class="flex items-center justify-center py-2 text-muted-foreground">
						<Loader2 class="w-4 h-4 animate-spin mr-2" />
						{m.activity_loading_more()}
					</div>
				{:else if !hasMore && events.length > 0}
					<div class="text-center py-2 text-sm text-muted-foreground">
						{m.activity_end_of_results({ count: total, total: total.toLocaleString() })}
					</div>
				{/if}
			{/snippet}
		</DataGrid>
	{/if}
</div>

<!-- Detail Dialog -->
<Dialog.Root bind:open={showDetailDialog}>
	<Dialog.Content class="max-w-4xl">
		<Dialog.Header>
			<Dialog.Title>{m.activity_details_title()}</Dialog.Title>
		</Dialog.Header>
		{#if selectedEvent}
			<div class="space-y-4">
				<div class="grid grid-cols-2 gap-4">
					<div>
						<label class="text-sm font-medium text-muted-foreground">{m.activity_details_timestamp()}</label>
						<p class="font-mono text-sm">{formatTimestamp(selectedEvent.timestamp)}</p>
					</div>
					<div>
						<label class="text-sm font-medium text-muted-foreground">{m.activity_details_action()}</label>
						<p>
							<Badge class="{getActionColor(selectedEvent.action)} gap-1">
								<svelte:component this={getActionIcon(selectedEvent.action)} class="w-3 h-3" />
								{selectedEvent.action}
							</Badge>
						</p>
					</div>
					<div class="min-w-0">
						<label class="text-sm font-medium text-muted-foreground">{m.activity_details_container_name()}</label>
						<p class="flex items-start gap-1">
							<Box class="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
							<span class="font-mono text-sm break-all min-w-0">{selectedEvent.containerName || '-'}</span>
						</p>
					</div>
					<div>
						<label class="text-sm font-medium text-muted-foreground">{m.activity_details_container_id()}</label>
						<p class="font-mono text-sm break-all">{selectedEvent.containerId}</p>
					</div>
					{#if selectedEvent.image}
						<div class="col-span-2">
							<label class="text-sm font-medium text-muted-foreground">{m.activity_details_image()}</label>
							<p class="font-mono text-sm break-all">{selectedEvent.image}</p>
						</div>
					{/if}
					{#if selectedEvent.environmentName}
						<div>
							<label class="text-sm font-medium text-muted-foreground">{m.activity_details_environment()}</label>
							<p>{selectedEvent.environmentName}</p>
						</div>
					{/if}
				</div>

				{#if selectedEvent.actorAttributes && Object.keys(selectedEvent.actorAttributes).length > 0}
					<div>
						<label class="text-sm font-medium text-muted-foreground">{m.activity_details_attributes()}</label>
						<div class="mt-1 border rounded-md overflow-hidden max-h-[200px] overflow-y-auto">
							<table class="w-full text-xs">
								<tbody>
									{#each Object.entries(selectedEvent.actorAttributes) as [key, value], i}
										<tr class="{i % 2 === 0 ? 'bg-muted/50' : 'bg-background'}">
											<td class="px-3 py-1.5 font-mono font-medium text-muted-foreground align-top break-all w-1/3">{key}</td>
											<td class="px-3 py-1.5 font-mono break-all align-top">{value}</td>
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
			<Button variant="outline" onclick={() => showDetailDialog = false}>{m.ui_close()}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
