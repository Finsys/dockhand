<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import {
		Calendar,
		RefreshCw,
		CircleArrowUp,
		CircleFadingArrowUp,
		Play,
		ChevronDown,
		ChevronRight,
		GitBranch,
		Clock,
		Check,
		CheckCheck,
		X,
		AlertCircle,
		Loader2,
		Search,
		Server,
		Wrench,
		Eye,
		EyeOff,
		Timer,
		Webhook,
		Hand,
		Minus,
		FileText,
		Pause,
		PlayCircle,
		Trash2,
		Bug,
		ShieldX
	} from 'lucide-svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { DataGrid } from '$lib/components/data-grid';
	import type { DataGridRowState } from '$lib/components/data-grid';
	import { toast } from 'svelte-sonner';
	import { formatDateTime, appSettings } from '$lib/stores/settings';
	import { getIconComponent } from '$lib/utils/icons';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import ScannerSeverityPills from '$lib/components/ScannerSeverityPills.svelte';
	import VulnerabilityCriteriaBadge from '$lib/components/VulnerabilityCriteriaBadge.svelte';
	import UpdateSummaryStats from '$lib/components/UpdateSummaryStats.svelte';
	import ExecutionLogViewer from '$lib/components/ExecutionLogViewer.svelte';
	import { vulnerabilityCriteriaIcons, vulnerabilityCriteriaLabels } from '$lib/utils/update-steps';
	import type { VulnerabilityCriteria } from '$lib/server/db';
	import cronstrue from 'cronstrue';

	// Scanner result per scanner
	interface ScannerResult {
		scanner: string;
		critical: number;
		high: number;
		medium: number;
		low: number;
	}

	// Blocked container info
	interface BlockedContainer {
		name: string;
		reason: string;
		scannerResults?: ScannerResult[];
	}

	// Container status in execution details
	interface ContainerStatus {
		name: string;
		status: 'updated' | 'blocked' | 'failed' | 'checked';
		blockReason?: string;
		scannerResults?: ScannerResult[];
		imageName?: string;
		currentDigest?: string;
		newDigest?: string;
	}

	// Scan result summary
	interface ScanResultSummary {
		critical: number;
		high: number;
		medium: number;
		low: number;
	}

	// Full scan result structure
	interface ScanResult {
		summary: ScanResultSummary;
		scannerResults?: ScannerResult[];
		scanners?: string[];
		scannedAt?: string;
	}

	// Details for env_update_check schedule type
	interface EnvUpdateCheckDetails {
		mode?: 'auto_update' | 'notify_only';
		updatesFound?: number;
		containersChecked?: number;
		errors?: number;
		autoUpdate?: boolean;
		vulnerabilityCriteria?: VulnerabilityCriteria;
		summary?: { checked: number; updated: number; blocked: number; failed: number };
		containers?: ContainerStatus[];
		updated?: number;
		blocked?: number;
		failed?: number;
		blockedContainers?: BlockedContainer[];
	}

	// Details for container_update schedule type
	interface ContainerUpdateDetails {
		reason?: string;
		newImage?: string;
		oldImage?: string;
		vulnerabilityCriteria?: VulnerabilityCriteria;
		blockReason?: string;
		scanResult?: ScanResult;
	}

	// Details for git_stack_sync schedule type
	interface GitStackSyncDetails {
		output?: string;
	}

	// Details for system_cleanup schedule type
	interface SystemCleanupDetails {
		retentionDays?: number;
		deletedCount?: number;
	}

	// Union type for all possible details
	type ScheduleExecutionDetails =
		| EnvUpdateCheckDetails
		| ContainerUpdateDetails
		| GitStackSyncDetails
		| SystemCleanupDetails
		| null;

	interface ScheduleExecution {
		id: number;
		scheduleType: 'container_update' | 'git_stack_sync' | 'system_cleanup' | 'env_update_check' | 'image_prune';
		scheduleId: number;
		environmentId: number | null;
		entityName: string;
		triggeredBy: 'cron' | 'webhook' | 'manual';
		triggeredAt: string;
		startedAt: string | null;
		completedAt: string | null;
		duration: number | null;
		status: 'queued' | 'running' | 'success' | 'failed' | 'skipped';
		errorMessage: string | null;
		details: ScheduleExecutionDetails;
		logs: string | null;
		createdAt: string | null;
	}

	interface Schedule {
		key: string; // Unique key: type-id
		id: number;
		type: 'container_update' | 'git_stack_sync' | 'system_cleanup' | 'env_update_check' | 'image_prune';
		name: string;
		entityName: string;
		description?: string;
		environmentId: number | null;
		environmentName: string | null;
		enabled: boolean;
		scheduleType: string;
		cronExpression: string | null;
		nextRun: string | null;
		lastExecution: ScheduleExecution | null;
		recentExecutions: ScheduleExecution[];
		isSystem: boolean;
		// Container update specific fields
		envHasScanning?: boolean;
		vulnerabilityCriteria?: string | null;
		// Env update check specific fields
		autoUpdate?: boolean;
	}

	// State
	let schedules = $state<Schedule[]>([]);
	let environments = $state<{ id: number; name: string; icon: string }[]>([]);
	let loading = $state(true);
	let refreshing = $state(false);
	let searchQuery = $state('');
	let filterTypes = $state<string[]>([]);
	let filterEnvironments = $state<string[]>([]);
	let filterStatuses = $state<string[]>([]);
	let expandedSchedules = $state<Set<string>>(new Set());
	let hideSystemJobs = $state(false); // Show by default

	// Infinite scroll state for expanded executions
	let expandedExecutions = $state<Map<string, ScheduleExecution[]>>(new Map());
	let loadingMoreExecutions = $state<Set<string>>(new Set());
	let hasMoreExecutions = $state<Map<string, boolean>>(new Map());
	const EXECUTIONS_BATCH_SIZE = 50;

	// Execution detail dialog
	let showExecutionDialog = $state(false);
	let selectedExecution = $state<ScheduleExecution | null>(null);
	let loadingExecutionDetail = $state(false);
	let logDarkMode = $state(true);

	function toggleLogTheme() {
		logDarkMode = !logDarkMode;
		localStorage.setItem('logTheme', logDarkMode ? 'dark' : 'light');
	}

	// Delete confirmation - track which schedule is being deleted
	let confirmDeleteId = $state<string | null>(null);

	// SSE event source for real-time updates
	let eventSource: EventSource | null = null;

	// Track timeout IDs for cleanup
	let pendingTimeouts: ReturnType<typeof setTimeout>[] = [];

	// Connection timeout for initial load
	let connectionTimeoutId: ReturnType<typeof setTimeout> | null = null;

	// Track if we've received the 'connected' event from the server
	// This is sent immediately, so if we don't receive it, the connection truly failed
	let receivedConnectedEvent = false;

	// Filter schedules
	const filteredSchedules = $derived.by(() => {
		let filtered = schedules;

		// Hide system jobs if toggle is on
		if (hideSystemJobs) {
			filtered = filtered.filter(s => !s.isSystem);
		}

		// Filter by types
		if (filterTypes.length > 0) {
			filtered = filtered.filter(s => filterTypes.includes(s.type));
		}

		// Filter by environments
		if (filterEnvironments.length > 0) {
			filtered = filtered.filter(s => s.environmentId !== null && filterEnvironments.includes(String(s.environmentId)));
		}

		// Filter by last execution status
		if (filterStatuses.length > 0) {
			filtered = filtered.filter(s => {
				if (!s.lastExecution) return false;
				return filterStatuses.includes(s.lastExecution.status);
			});
		}

		// Filter by search
		if (searchQuery) {
			const query = searchQuery.toLowerCase();
			filtered = filtered.filter(s =>
				s.name.toLowerCase().includes(query) ||
				s.entityName.toLowerCase().includes(query) ||
				(s.environmentName?.toLowerCase().includes(query) ?? false)
			);
		}

		return filtered;
	});

	// Count system jobs for badge
	const systemJobCount = $derived.by(() => schedules.filter(s => s.isSystem).length);

	// Check if any filters are active
	const hasActiveFilters = $derived.by(() =>
		searchQuery.length > 0 ||
		filterTypes.length > 0 ||
		filterEnvironments.length > 0 ||
		filterStatuses.length > 0
	);

	// Clear all filters
	function clearFilters() {
		searchQuery = '';
		filterTypes = [];
		filterEnvironments = [];
		filterStatuses = [];
	}

	// Get unique key for a schedule
	function getScheduleKey(schedule: Schedule): string {
		return schedule.type + '-' + schedule.id;
	}

	function connectToStream() {
		if (eventSource) {
			eventSource.close();
		}

		// Clear any existing connection timeout
		if (connectionTimeoutId) {
			clearTimeout(connectionTimeoutId);
			connectionTimeoutId = null;
		}

		// Reset connection state for new connection attempt
		receivedConnectedEvent = false;

		eventSource = new EventSource('/api/schedules/stream');

		// Set a connection timeout - only show "no schedules" if we never received
		// the 'connected' event (meaning the connection truly failed).
		// If we received 'connected' but are waiting for data, keep showing the loader.
		connectionTimeoutId = setTimeout(() => {
			if (loading && !receivedConnectedEvent) {
				// Connection truly failed - no 'connected' event received
				console.warn('Schedule stream timeout - connection failed');
				loading = false;
				refreshing = false;
			}
			// If receivedConnectedEvent is true, keep loading - data is on the way
		}, 5000);

		// Handle connection confirmation (sent immediately by server)
		eventSource.addEventListener('connected', () => {
			receivedConnectedEvent = true;
			// Clear connection timeout - we're connected, just waiting for data
			if (connectionTimeoutId) {
				clearTimeout(connectionTimeoutId);
				connectionTimeoutId = null;
			}
		});

		eventSource.addEventListener('schedules', (event) => {
			// Also clear connection timeout on first data event (fallback)
			if (connectionTimeoutId) {
				clearTimeout(connectionTimeoutId);
				connectionTimeoutId = null;
			}
			try {
				const data = JSON.parse(event.data);
				// Add unique key to each schedule
				schedules = data.schedules.map((s: Omit<Schedule, 'key'>) => ({
					...s,
					key: `${s.type}-${s.id}`
				}));

				// Update expanded executions if any schedules are expanded
				// This ensures the execution history table stays in sync
				for (const schedule of data.schedules) {
					const scheduleKey = schedule.type + '-' + schedule.id;
					if (expandedSchedules.has(scheduleKey) && schedule.recentExecutions) {
						// Check if we have new executions that aren't in the current list
						const currentExecutions = expandedExecutions.get(scheduleKey) || [];
						const newExecutions = schedule.recentExecutions;

						// Check if the latest execution is different (new execution added)
						if (newExecutions.length > 0) {
							const latestNew = newExecutions[0];
							const latestCurrent = currentExecutions[0];

							if (!latestCurrent || latestNew.id !== latestCurrent.id ||
								latestNew.status !== latestCurrent.status) {
								// Merge new executions with existing ones
								const existingIds = new Set(currentExecutions.map(e => e.id));
								const toAdd = newExecutions.filter(e => !existingIds.has(e.id));

								// Update existing executions and prepend new ones
								const updated = currentExecutions.map(e => {
									const newer = newExecutions.find(n => n.id === e.id);
									return newer || e;
								});

								const merged = [...toAdd, ...updated];

								const newExecutionsMap = new Map(expandedExecutions);
								newExecutionsMap.set(scheduleKey, merged);
								expandedExecutions = newExecutionsMap;
							}
						}
					}
				}

				loading = false;
				refreshing = false;
			} catch (error) {
				console.error('Failed to parse schedules data:', error);
			}
		});

		eventSource.addEventListener('error', (event: Event) => {
			// This handles two types of errors:
			// 1. SSE connection errors (event.type === 'error' with no data)
			// 2. Server-sent error events (event is MessageEvent with data)

			// Clear connection timeout
			if (connectionTimeoutId) {
				clearTimeout(connectionTimeoutId);
				connectionTimeoutId = null;
			}

			// Check if this is a server-sent error event with data
			const messageEvent = event as MessageEvent;
			if (messageEvent.data) {
				try {
					const errorData = JSON.parse(messageEvent.data);
					console.error('[Schedules] Server error:', errorData.error);
					if (errorData.fatal) {
						// Fatal error - server couldn't get initial data after retries
						toast.error('Failed to load schedules: ' + errorData.error);
					}
				} catch {
					// Not a JSON error event, treat as connection error
				}
			}

			// Stop loading on error (shows empty state instead of spinner)
			loading = false;
			refreshing = false;

			// Try to reconnect after a delay
			// Reconnect even if schedules is empty - the server might recover
			const timeoutId = setTimeout(() => {
				if (eventSource?.readyState === EventSource.CLOSED) {
					console.log('[Schedules] Attempting to reconnect SSE...');
					connectToStream();
				}
			}, 5000);
			pendingTimeouts.push(timeoutId);
		});
	}

	// Fetch schedules from REST endpoint (for immediate updates without disrupting SSE)
	async function refreshSchedulesFromRest() {
		try {
			const res = await fetch('/api/schedules');
			if (res.ok) {
				const data = await res.json();
				// Add unique key to each schedule
				schedules = data.schedules.map((s: Omit<Schedule, 'key'>) => ({
					...s,
					key: `${s.type}-${s.id}`
				}));
				loading = false;
				refreshing = false;
			}
		} catch (error) {
			console.error('Failed to refresh schedules from REST:', error);
		}
	}

	async function loadSchedules() {
		// Force a reconnect to get fresh data immediately
		refreshing = true;
		connectToStream();
	}

	async function loadEnvironments() {
		try {
			const res = await fetch('/api/environments');
			if (res.ok) {
				environments = await res.json();
			}
		} catch (error) {
			console.error('Failed to load environments:', error);
		}
	}

	async function loadSettings() {
		try {
			const res = await fetch('/api/schedules/settings');
			if (res.ok) {
				const data = await res.json();
				hideSystemJobs = data.hideSystemJobs ?? false;
			}
		} catch (error) {
			console.error('Failed to load settings:', error);
		}
	}

	async function toggleHideSystemJobs() {
		hideSystemJobs = !hideSystemJobs;
		// Remove system_cleanup from filter if hiding system jobs
		if (hideSystemJobs && filterTypes.includes('system_cleanup')) {
			filterTypes = filterTypes.filter(t => t !== 'system_cleanup');
		}
		// Save preference in background
		try {
			await fetch('/api/schedules/settings', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ hideSystemJobs })
			});
		} catch (error) {
			console.error('Failed to save hide system jobs preference:', error);
		}
	}

	async function loadScheduleExecutions(schedule: Schedule, offset = 0) {
		const scheduleKey = schedule.type + '-' + schedule.id;

		// Mark as loading - create new Set to trigger reactivity
		const loadingSet = new Set(loadingMoreExecutions);
		loadingSet.add(scheduleKey);
		loadingMoreExecutions = loadingSet;

		try {
			const res = await fetch(
				`/api/schedules/executions?scheduleType=${schedule.type}&scheduleId=${schedule.id}&limit=${EXECUTIONS_BATCH_SIZE}&offset=${offset}`
			);
			if (!res.ok) throw new Error('Failed to load executions');
			const data = await res.json();

			const executions = data.executions || [];
			const currentExecutions = expandedExecutions.get(scheduleKey) || [];

			// Append new executions - create new Map to trigger reactivity
			const newExecutionsMap = new Map(expandedExecutions);
			newExecutionsMap.set(scheduleKey, [...currentExecutions, ...executions]);
			expandedExecutions = newExecutionsMap;

			// Check if there are more executions - create new Map to trigger reactivity
			const newHasMoreMap = new Map(hasMoreExecutions);
			newHasMoreMap.set(scheduleKey, executions.length === EXECUTIONS_BATCH_SIZE);
			hasMoreExecutions = newHasMoreMap;
		} catch (error: any) {
			toast.error('Failed to load executions: ' + error.message);
		} finally {
			// Remove loading state - create new Set to trigger reactivity
			const loadingSet = new Set(loadingMoreExecutions);
			loadingSet.delete(scheduleKey);
			loadingMoreExecutions = loadingSet;
		}
	}

	function toggleScheduleExpansion(schedule: Schedule) {
		const scheduleKey = schedule.type + '-' + schedule.id;

		if (expandedSchedules.has(scheduleKey)) {
			// Collapse - create new Set to trigger reactivity
			const newSet = new Set(expandedSchedules);
			newSet.delete(scheduleKey);
			expandedSchedules = newSet;
		} else {
			// Expand - create new Set to trigger reactivity
			const newSet = new Set(expandedSchedules);
			newSet.add(scheduleKey);
			expandedSchedules = newSet;

			// Load first batch if not already loaded
			if (!expandedExecutions.has(scheduleKey)) {
				loadScheduleExecutions(schedule, 0);
			}
		}
	}

	// Handle DataGrid expand change
	function handleExpandChange(key: unknown, expanded: boolean) {
		const scheduleKey = key as string;
		const schedule = filteredSchedules.find(s => getScheduleKey(s) === scheduleKey);
		if (schedule) {
			if (expanded && !expandedExecutions.has(scheduleKey)) {
				loadScheduleExecutions(schedule, 0);
			}
		}
	}

	async function triggerSchedule(schedule: Schedule) {
		try {
			const res = await fetch(`/api/schedules/${schedule.type}/${schedule.id}/run`, {
				method: 'POST'
			});
			if (!res.ok) {
				const data = await res.json();
				throw new Error(data.error || 'Failed to trigger schedule');
			}
			toast.success(`Triggered: ${schedule.name}`);

			// Refresh schedules from REST after a short delay to show running status
			// This doesn't disrupt the SSE stream but ensures spinner appears quickly
			const scheduleKey = schedule.type + '-' + schedule.id;
			const timeoutId = setTimeout(async () => {
				await refreshSchedulesFromRest();
				if (expandedSchedules.has(scheduleKey)) {
					// Fetch just the latest execution without clearing the list
					try {
						const res = await fetch(
							`/api/schedules/executions?scheduleType=${schedule.type}&scheduleId=${schedule.id}&limit=1&offset=0`
						);
						if (res.ok) {
							const data = await res.json();
							const newExecution = data.executions?.[0];

							if (newExecution) {
								const currentExecutions = expandedExecutions.get(scheduleKey) || [];

								// Check if this execution already exists (by ID)
								const existsIndex = currentExecutions.findIndex(e => e.id === newExecution.id);

								if (existsIndex >= 0) {
									// Update existing execution in place
									currentExecutions[existsIndex] = newExecution;
								} else {
									// Prepend new execution to the list
									currentExecutions.unshift(newExecution);
								}

								// Update map with new array reference
								const newExecutionsMap = new Map(expandedExecutions);
								newExecutionsMap.set(scheduleKey, [...currentExecutions]);
								expandedExecutions = newExecutionsMap;
							}
						}
					} catch (error) {
						console.error('Failed to refresh execution:', error);
					}
				}
			}, 1000);
			pendingTimeouts.push(timeoutId);
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	async function toggleScheduleEnabled(schedule: Schedule) {
		try {
			// Use different endpoint for system schedules
			const endpoint = schedule.isSystem
				? `/api/schedules/system/${schedule.id}/toggle`
				: `/api/schedules/${schedule.type}/${schedule.id}/toggle`;

			const res = await fetch(endpoint, {
				method: 'POST'
			});
			if (!res.ok) {
				const data = await res.json();
				throw new Error(data.error || 'Failed to toggle schedule');
			}
			toast.success(`Schedule ${schedule.enabled ? 'paused' : 'resumed'}`);
			loadSchedules();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	async function deleteSchedule(scheduleType: string, scheduleId: number, entityName: string) {
		try {
			const res = await fetch(`/api/schedules/${scheduleType}/${scheduleId}`, {
				method: 'DELETE'
			});
			if (!res.ok) {
				const data = await res.json();
				throw new Error(data.error || 'Failed to delete schedule');
			}
			toast.success(`Schedule removed: ${entityName}`);
			confirmDeleteId = null;
			loadSchedules();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	async function loadExecutionDetail(executionId: number) {
		loadingExecutionDetail = true;
		try {
			const res = await fetch(`/api/schedules/executions/${executionId}`);
			if (!res.ok) throw new Error('Failed to load execution');
			selectedExecution = await res.json();
			showExecutionDialog = true;
		} catch (error: any) {
			toast.error('Failed to load execution: ' + error.message);
		} finally {
			loadingExecutionDetail = false;
		}
	}

	async function deleteExecution(schedule: Schedule, executionId: number) {
		try {
			const res = await fetch(`/api/schedules/executions/${executionId}`, {
				method: 'DELETE'
			});
			if (!res.ok) {
				const data = await res.json();
				throw new Error(data.error || 'Failed to delete execution');
			}

			toast.success('Execution deleted');

			// Remove from the expanded executions list
			const scheduleKey = schedule.type + '-' + schedule.id;
			const currentExecutions = expandedExecutions.get(scheduleKey) || [];
			const filtered = currentExecutions.filter(e => e.id !== executionId);

			const newExecutionsMap = new Map(expandedExecutions);
			newExecutionsMap.set(scheduleKey, filtered);
			expandedExecutions = newExecutionsMap;

			// Refresh schedules to update the last execution badge
			loadSchedules();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	async function deleteAllExecutions(schedule: Schedule) {
		try {
			const scheduleKey = schedule.type + '-' + schedule.id;
			const executions = expandedExecutions.get(scheduleKey) || [];

			if (executions.length === 0) {
				toast.error('No executions to delete');
				return;
			}

			// Delete all executions
			const deletePromises = executions.map(exec =>
				fetch(`/api/schedules/executions/${exec.id}`, { method: 'DELETE' })
			);

			await Promise.all(deletePromises);

			toast.success(`Deleted ${executions.length} execution(s)`);

			// Clear from the expanded executions list
			const newExecutionsMap = new Map(expandedExecutions);
			newExecutionsMap.delete(scheduleKey);
			expandedExecutions = newExecutionsMap;

			// Collapse the row since there are no more executions
			const newExpandedSet = new Set(expandedSchedules);
			newExpandedSet.delete(scheduleKey);
			expandedSchedules = newExpandedSet;

			// Refresh schedules to update the last execution badge
			loadSchedules();
		} catch (error: any) {
			toast.error('Failed to delete executions: ' + error.message);
		}
	}

	function formatTimestamp(iso: string | null): string {
		if (!iso) return '-';
		return formatDateTime(iso, true);
	}

	function formatDuration(ms: number | null): string {
		if (ms === null) return '-';
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
		return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
	}

	function formatNextRun(iso: string | null): string {
		if (!iso) return '-';
		const date = new Date(iso);
		const now = new Date();
		const diff = date.getTime() - now.getTime();

		if (diff < 0) return 'Overdue';
		if (diff < 60000) return 'Less than 1 min';
		if (diff < 3600000) return `In ${Math.floor(diff / 60000)} min`;
		if (diff < 86400000) return `In ${Math.floor(diff / 3600000)} hours`;
		return formatTimestamp(iso);
	}

	function getStatusBadge(status: string) {
		switch (status) {
			case 'success':
				return { variant: 'default' as const, class: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400', icon: Check };
			case 'failed':
				return { variant: 'default' as const, class: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400', icon: X };
			case 'running':
				return { variant: 'default' as const, class: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400', icon: Loader2 };
			case 'skipped':
				return { variant: 'default' as const, class: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400', icon: CheckCheck };
			case 'queued':
				return { variant: 'default' as const, class: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400', icon: Clock };
			default:
				return { variant: 'default' as const, class: 'bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-400', icon: AlertCircle };
		}
	}

	// Get effective status for env_update_check with blocked containers
	function getEnvUpdateStatus(exec: ScheduleExecution): { status: string; label: string; icon: any; class: string } | null {
		if (exec.scheduleType !== 'env_update_check' || !exec.details?.autoUpdate) return null;

		const blocked = exec.details.blocked ?? 0;
		const updated = exec.details.updated ?? 0;
		const failed = exec.details.failed ?? 0;

		if (blocked > 0 && updated > 0) {
			// Some updated, some blocked
			return {
				status: 'partial',
				label: 'Partially blocked',
				icon: Bug,
				class: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
			};
		} else if (blocked > 0 && updated === 0 && failed === 0) {
			// All blocked, none updated
			return {
				status: 'blocked',
				label: 'Blocked',
				icon: Bug,
				class: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
			};
		}
		return null;
	}

	function getTriggerBadge(trigger: string) {
		switch (trigger) {
			case 'cron':
				return {
					icon: Timer,
					label: 'Scheduled',
					class: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400'
				};
			case 'webhook':
				return {
					icon: Webhook,
					label: 'Webhook',
					class: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
				};
			case 'manual':
				return {
					icon: Hand,
					label: 'Manual',
					class: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400'
				};
			default:
				return {
					icon: AlertCircle,
					label: trigger,
					class: 'bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-400'
				};
		}
	}

	// Handle tab visibility changes (e.g., user switches back from another tab)
	function handleVisibilityChange() {
		if (document.visibilityState === 'visible') {
			// Tab became visible - reconnect SSE if it's closed
			if (!eventSource || eventSource.readyState !== EventSource.OPEN) {
				connectToStream();
			}
			// Also refresh data immediately
			refreshSchedulesFromRest();
		}
	}

	onMount(async () => {
		// Load settings and environments in parallel
		loadSettings();
		loadEnvironments();

		// Listen for tab visibility changes to reconnect when user returns
		document.addEventListener('visibilitychange', handleVisibilityChange);
		document.addEventListener('resume', handleVisibilityChange);

		// Load initial data from REST immediately for fast display
		// This ensures we have data even if SSE connection is slow/fails
		await refreshSchedulesFromRest();

		// Then connect to SSE for live updates
		connectToStream();

		// Load log theme preference
		const savedLogTheme = localStorage.getItem('logTheme');
		if (savedLogTheme !== null) {
			logDarkMode = savedLogTheme === 'dark';
		}
	});

	onDestroy(() => {
		document.removeEventListener('visibilitychange', handleVisibilityChange);
		document.removeEventListener('resume', handleVisibilityChange);
		if (eventSource) {
			eventSource.close();
			eventSource = null;
		}
		// Clear connection timeout
		if (connectionTimeoutId) {
			clearTimeout(connectionTimeoutId);
			connectionTimeoutId = null;
		}
		// Clear any pending timeouts
		pendingTimeouts.forEach(id => clearTimeout(id));
		pendingTimeouts = [];
	});
</script>

<svelte:head>
	<title>Schedules - Dockhand</title>
</svelte:head>

<div class="flex-1 min-h-0 flex flex-col gap-3 overflow-hidden">
	<!-- Header with filters -->
	<div class="shrink-0 flex flex-wrap justify-between items-center gap-3 min-h-8">
		<PageHeader icon={Timer} title="Schedules" count={filteredSchedules.length} />
		<div class="flex flex-wrap items-center gap-2">
			<div class="relative">
				<Search class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
				<Input
					type="text"
					placeholder="Search schedules..."
					class="pl-9 w-48 h-8 text-sm"
					bind:value={searchQuery}
					onkeydown={(e) => e.key === 'Escape' && (searchQuery = '')}
				/>
			</div>

			<!-- Type filter (multiselect) -->
			<Select.Root type="multiple" bind:value={filterTypes}>
				<Select.Trigger size="sm" class="w-40 text-sm">
					<span class="truncate">
						{#if filterTypes.length === 0}
							All types
						{:else if filterTypes.length === 1}
							{#if filterTypes[0] === 'container_update'}
								Container updates
							{:else if filterTypes[0] === 'git_stack_sync'}
								Git stack syncs
							{:else if filterTypes[0] === 'env_update_check'}
								Env update checks
							{:else if filterTypes[0] === 'image_prune'}
								Image prune
							{:else}
								System jobs
							{/if}
						{:else}
							{filterTypes.length} types
						{/if}
					</span>
				</Select.Trigger>
				<Select.Content>
					{#if filterTypes.length > 0}
						<button
							type="button"
							class="w-full px-2 py-1 text-xs text-left text-muted-foreground/60 hover:text-muted-foreground"
							onclick={() => filterTypes = []}
						>
							Clear
						</button>
					{/if}
					<Select.Item value="container_update">
						<CircleArrowUp class="w-4 h-4 mr-2 inline text-green-500 drop-shadow-[0_0_3px_rgba(34,197,94,0.4)]" />
						Container updates
					</Select.Item>
					<Select.Item value="git_stack_sync">
						<GitBranch class="w-4 h-4 mr-2 inline text-purple-500 drop-shadow-[0_0_3px_rgba(168,85,247,0.4)]" />
						Git stack syncs
					</Select.Item>
					<Select.Item value="env_update_check">
						<CircleFadingArrowUp class="w-4 h-4 mr-2 inline text-green-500/50 drop-shadow-[0_0_3px_rgba(34,197,94,0.3)]" />
						Env update checks
					</Select.Item>
					<Select.Item value="image_prune">
						<Trash2 class="w-4 h-4 mr-2 inline text-amber-500 drop-shadow-[0_0_3px_rgba(245,158,11,0.4)]" />
						Image prune
					</Select.Item>
					{#if !hideSystemJobs}
						<Select.Item value="system_cleanup">
							<Wrench class="w-4 h-4 mr-2 inline text-amber-500 drop-shadow-[0_0_3px_rgba(245,158,11,0.4)]" />
							System jobs
						</Select.Item>
					{/if}
				</Select.Content>
			</Select.Root>

			<!-- Environment filter (multiselect) -->
			<Select.Root type="multiple" bind:value={filterEnvironments}>
				<Select.Trigger size="sm" class="w-40 text-sm">
					<Server class="w-3.5 h-3.5 mr-2 shrink-0" />
					<span class="truncate">
						{#if filterEnvironments.length === 0}
							All envs
						{:else if filterEnvironments.length === 1}
							{environments.find(e => String(e.id) === filterEnvironments[0])?.name || 'Environment'}
						{:else}
							{filterEnvironments.length} envs
						{/if}
					</span>
				</Select.Trigger>
				<Select.Content>
					{#if filterEnvironments.length > 0}
						<button
							type="button"
							class="w-full px-2 py-1 text-xs text-left text-muted-foreground/60 hover:text-muted-foreground"
							onclick={() => filterEnvironments = []}
						>
							Clear
						</button>
					{/if}
					{#each environments as env}
						{@const EnvIcon = getIconComponent(env.icon)}
						<Select.Item value={String(env.id)}>
							<EnvIcon class="w-4 h-4 mr-2 inline" />
							{env.name}
						</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>

			<!-- Status filter (multiselect) -->
			<Select.Root type="multiple" bind:value={filterStatuses}>
				<Select.Trigger size="sm" class="w-36 text-sm">
					<span class="truncate">
						{#if filterStatuses.length === 0}
							All statuses
						{:else if filterStatuses.length === 1}
							{#if filterStatuses[0] === 'success'}
								Success
							{:else if filterStatuses[0] === 'failed'}
								Failed
							{:else if filterStatuses[0] === 'skipped'}
								Up-to-date
							{:else if filterStatuses[0] === 'running'}
								Running
							{:else}
								{filterStatuses[0]}
							{/if}
						{:else}
							{filterStatuses.length} statuses
						{/if}
					</span>
				</Select.Trigger>
				<Select.Content>
					{#if filterStatuses.length > 0}
						<button
							type="button"
							class="w-full px-2 py-1 text-xs text-left text-muted-foreground/60 hover:text-muted-foreground"
							onclick={() => filterStatuses = []}
						>
							Clear
						</button>
					{/if}
					<Select.Item value="success">
						<Check class="w-4 h-4 mr-2 inline text-green-500" />
						Success
					</Select.Item>
					<Select.Item value="failed">
						<X class="w-4 h-4 mr-2 inline text-red-500" />
						Failed
					</Select.Item>
					<Select.Item value="skipped">
						<CheckCheck class="w-4 h-4 mr-2 inline text-green-500" />
						Up-to-date
					</Select.Item>
					<Select.Item value="running">
						<Loader2 class="w-4 h-4 mr-2 inline text-sky-500 animate-spin" />
						Running
					</Select.Item>
				</Select.Content>
			</Select.Root>

			<!-- Toggle system jobs visibility -->
			{#if systemJobCount > 0}
				<Button
					variant={hideSystemJobs ? 'outline' : 'secondary'}
					size="sm"
					class="h-8"
					onclick={toggleHideSystemJobs}
				>
					{#if hideSystemJobs}
						<Eye class="w-3.5 h-3.5" />
						Show system ({systemJobCount})
					{:else}
						<EyeOff class="w-3.5 h-3.5" />
						Hide system
					{/if}
				</Button>
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

			<Button
				variant="outline"
				size="sm"
				class="h-8 w-8 p-0"
				onclick={() => { refreshing = true; loadSchedules(); }}
				disabled={refreshing}
			>
				<RefreshCw class="w-3.5 h-3.5 {refreshing ? 'animate-spin' : ''}" />
			</Button>
		</div>
	</div>

	<!-- DataGrid -->
	<DataGrid
		data={filteredSchedules}
		keyField="key"
		gridId="schedules"
		loading={loading}
		bind:expandedKeys={expandedSchedules}
		onExpandChange={handleExpandChange}
		onRowClick={(schedule, e) => {
			if (schedule.lastExecution !== null) {
				toggleScheduleExpansion(schedule);
			}
		}}
		class="border-none"
		wrapperClass="border rounded-lg"
	>
		{#snippet cell(column, schedule, rowState)}
			{#if column.id === 'expand'}
				{#if schedule.lastExecution !== null}
					<button
						type="button"
						class="p-0.5 hover:bg-muted rounded transition-colors"
						onclick={(e) => { e.stopPropagation(); toggleScheduleExpansion(schedule); }}
					>
						{#if rowState.isExpanded}
							<ChevronDown class="w-4 h-4" />
						{:else}
							<ChevronRight class="w-4 h-4" />
						{/if}
					</button>
				{/if}
			{:else if column.id === 'schedule'}
				<div class="flex flex-wrap items-center gap-2">
					{#if schedule.type === 'container_update'}
						<CircleArrowUp class="w-4 h-4 text-green-500 glow-green shrink-0" />
					{:else if schedule.type === 'git_stack_sync'}
						<GitBranch class="w-4 h-4 text-emerald-500 shrink-0" />
					{:else if schedule.type === 'env_update_check'}
						{#if schedule.autoUpdate}
							<CircleArrowUp class="w-4 h-4 text-green-500 glow-green shrink-0" />
						{:else}
							<CircleFadingArrowUp class="w-4 h-4 text-green-500 glow-green shrink-0" />
						{/if}
					{:else if schedule.type === 'image_prune'}
						<Trash2 class="w-4 h-4 text-amber-500 glow-amber shrink-0" />
					{:else}
						<Wrench class="w-4 h-4 text-amber-500 shrink-0" />
					{/if}
					<div class="min-w-0">
						<div class="font-medium flex items-center gap-2 truncate">
							<span class="truncate">{schedule.name}</span>
							{#if schedule.isSystem}
								<Badge variant="outline" class="text-xs shrink-0">System</Badge>
							{/if}
						</div>
						<div class="text-xs text-muted-foreground flex items-center gap-1 truncate">
							{#if schedule.type === 'container_update'}
								{#if schedule.envHasScanning}
									{@const criteria = (schedule.vulnerabilityCriteria || 'never') as VulnerabilityCriteria}
									{@const icon = vulnerabilityCriteriaIcons[criteria]}
									{@const IconComponent = icon.component}
									<span class="cursor-default shrink-0" title={icon.title}>
										<IconComponent class={icon.class} />
									</span>
									Check, scan & auto-update
								{:else}
									Check & auto-update
								{/if}
							{:else if schedule.type === 'git_stack_sync'}
								Git sync
							{:else if schedule.type === 'env_update_check'}
								{#if schedule.autoUpdate && schedule.envHasScanning && schedule.vulnerabilityCriteria}
									{@const criteria = schedule.vulnerabilityCriteria as VulnerabilityCriteria}
									{@const icon = vulnerabilityCriteriaIcons[criteria]}
									{@const IconComponent = icon.component}
									<span class="cursor-default shrink-0" title={icon.title}>
										<IconComponent class={icon.class} />
									</span>
								{/if}
								<span class="truncate">{schedule.description || 'Env update check'}</span>
							{:else if schedule.type === 'image_prune'}
								<span class="truncate">{schedule.description || 'Prune unused images'}</span>
							{:else}
								<span class="truncate">{schedule.description || 'System job'}</span>
							{/if}
						</div>
					</div>
				</div>
			{:else if column.id === 'environment'}
				{#if schedule.environmentName}
					<div class="flex items-center gap-1 text-xs">
						<Server class="w-3 h-3 shrink-0" />
						<span class="truncate">{schedule.environmentName}</span>
					</div>
				{:else}
					<span class="text-muted-foreground">-</span>
				{/if}
			{:else if column.id === 'cron'}
				<div class="flex items-center gap-1">
					<Clock class="w-3 h-3 text-muted-foreground shrink-0" />
					<span class="text-xs truncate">
						{#if schedule.cronExpression}
							{(() => {
								try {
									const is12Hour = $appSettings.timeFormat === '12h';
									return cronstrue.toString(schedule.cronExpression, {
										use24HourTimeFormat: !is12Hour,
										throwExceptionOnParseError: true,
										locale: 'en'
									});
								} catch {
									return schedule.cronExpression;
								}
							})()}
						{:else}
							{schedule.scheduleType}
						{/if}
					</span>
				</div>
			{:else if column.id === 'lastRun'}
				{#if schedule.lastExecution}
					<div class="text-xs">{formatTimestamp(schedule.lastExecution.triggeredAt)}</div>
					{#if schedule.lastExecution.duration}
						<div class="flex items-center gap-1 text-xs text-muted-foreground">
							<Timer class="w-3 h-3" />
							{formatDuration(schedule.lastExecution.duration)}
						</div>
					{/if}
				{:else}
					<span class="text-muted-foreground text-xs">Never</span>
				{/if}
			{:else if column.id === 'nextRun'}
				<span class="text-xs">{formatNextRun(schedule.nextRun)}</span>
			{:else if column.id === 'status'}
				{#if schedule.lastExecution}
					{@const badge = getStatusBadge(schedule.lastExecution.status)}
					{@const envUpdateStatus = getEnvUpdateStatus(schedule.lastExecution)}
					{@const isBlockedByVuln = schedule.lastExecution.details?.reason === 'vulnerabilities_found'}
					<Tooltip.Root>
						<Tooltip.Trigger>
							{#if envUpdateStatus}
								{@const EnvUpdateIcon = envUpdateStatus.icon}
								<Badge variant="default" class={envUpdateStatus.class}>
									<EnvUpdateIcon class="w-3.5 h-3.5" />
								</Badge>
							{:else if isBlockedByVuln}
								<Badge variant="default" class="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
									<Bug class="w-3.5 h-3.5" />
								</Badge>
							{:else}
								{@const BadgeIcon = badge.icon}
								<Badge variant={badge.variant} class={badge.class}>
									<BadgeIcon class="w-3.5 h-3.5 {schedule.lastExecution.status === 'running' ? 'animate-spin' : ''}" />
								</Badge>
							{/if}
						</Tooltip.Trigger>
						<Tooltip.Content side="left">
							<p class="whitespace-nowrap">
								{#if envUpdateStatus}
									{envUpdateStatus.label}
								{:else if isBlockedByVuln}
									Update blocked due to vulnerabilities
								{:else if schedule.lastExecution.status === 'skipped'}
									Up-to-date
								{:else}
									<span class="capitalize">{schedule.lastExecution.status}</span>
								{/if}
							</p>
						</Tooltip.Content>
					</Tooltip.Root>
				{:else}
					<Tooltip.Root>
						<Tooltip.Trigger>
							<Badge variant="default" class="bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-400">
								<Minus class="w-3.5 h-3.5" />
							</Badge>
						</Tooltip.Trigger>
						<Tooltip.Content>
							<p class="whitespace-nowrap">No runs</p>
						</Tooltip.Content>
					</Tooltip.Root>
				{/if}
			{:else if column.id === 'actions'}
				<div class="flex items-center gap-1">
					{#if schedule.lastExecution}
						<button
							type="button"
							onclick={(e) => { e.stopPropagation(); loadExecutionDetail(schedule.lastExecution!.id); }}
							title="View last execution logs"
							class="p-0.5 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
						>
							<FileText class="w-3 h-3 text-muted-foreground hover:text-blue-500" />
						</button>
					{/if}
					<button
						type="button"
						onclick={(e) => { e.stopPropagation(); toggleScheduleEnabled(schedule); }}
						title={schedule.enabled ? 'Pause schedule' : 'Resume schedule'}
						class="p-0.5 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
					>
						{#if schedule.enabled}
							<Pause class="w-3 h-3 text-muted-foreground hover:text-amber-500" />
						{:else}
							<PlayCircle class="w-3 h-3 text-muted-foreground hover:text-green-500" />
						{/if}
					</button>
					<button
						type="button"
						onclick={(e) => { e.stopPropagation(); triggerSchedule(schedule); }}
						title="Run now"
						class="p-0.5 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
					>
						<Play class="w-3 h-3 text-muted-foreground hover:text-green-500" />
					</button>
					{#if !schedule.isSystem}
						{@const scheduleKey = getScheduleKey(schedule)}
						<ConfirmPopover
							open={confirmDeleteId === scheduleKey}
							action="Remove"
							itemType="schedule"
							itemName={schedule.entityName}
							title="Remove schedule"
							onConfirm={() => deleteSchedule(schedule.type, schedule.id, schedule.entityName)}
							onOpenChange={(open) => confirmDeleteId = open ? scheduleKey : null}
						>
							{#snippet children({ open })}
								<Trash2 class="w-3 h-3 {open ? 'text-destructive' : 'text-muted-foreground hover:text-red-500'}" />
							{/snippet}
						</ConfirmPopover>
					{/if}
				</div>
			{/if}
		{/snippet}

		{#snippet expandedRow(schedule, rowState)}
			{@const scheduleKey = getScheduleKey(schedule)}
			{@const executions = expandedExecutions.get(scheduleKey) || []}
			{@const isLoading = loadingMoreExecutions.has(scheduleKey)}
			{@const canLoadMore = hasMoreExecutions.get(scheduleKey) ?? false}
			<div class="p-4 pl-12 shadow-inner bg-muted isolate sticky left-0 max-w-[calc(100vw-18rem)]">
				<div class="flex items-center justify-between mb-2">
					<h4 class="text-xs font-medium">Execution history</h4>
					{#if executions.length > 0}
						<button
							type="button"
							onclick={() => deleteAllExecutions(schedule)}
							title="Remove all executions"
							class="text-xs text-muted-foreground hover:text-red-500 transition-colors flex items-center gap-1"
						>
							<Trash2 class="w-3 h-3" />
							Remove all
						</button>
					{/if}
				</div>
				{#if executions.length > 0}
					<div class="max-h-96 overflow-auto">
						<table class="w-full table-fixed">
							<thead class="sticky top-0 bg-muted z-20">
								<tr class="text-xs text-muted-foreground">
									<th class="text-left px-2 py-1 w-36">Triggered</th>
									<th class="text-center px-2 py-1 w-20">Trigger</th>
									<th class="text-left px-2 py-1 w-20">Duration</th>
									<th class="text-center px-2 py-1 w-14">Status</th>
									<th class="text-left px-2 py-1">Error</th>
									<th class="text-left px-2 py-1 w-14"></th>
								</tr>
							</thead>
							<tbody>
								{#each executions as exec}
									{@const badge = getStatusBadge(exec.status)}
									{@const trigger = getTriggerBadge(exec.triggeredBy)}
									<tr class="border-t border-muted hover:bg-muted/50">
										<td class="px-2 py-1 text-xs">{formatTimestamp(exec.triggeredAt)}</td>
										<td class="px-2 py-1 text-center">
											<Tooltip.Root>
												<Tooltip.Trigger>
													{@const TriggerIcon = trigger.icon}
													<Badge variant="default" class={trigger.class}>
														<TriggerIcon class="w-3.5 h-3.5" />
													</Badge>
												</Tooltip.Trigger>
												<Tooltip.Content>
													<p>{trigger.label}</p>
												</Tooltip.Content>
											</Tooltip.Root>
										</td>
										<td class="px-2 py-1 text-xs"><div class="flex items-center gap-1"><Timer class="w-3 h-3 text-muted-foreground" />{formatDuration(exec.duration)}</div></td>
										<td class="px-2 py-1 text-center">
											<Tooltip.Root>
												<Tooltip.Trigger>
													{#if exec.details?.reason === 'vulnerabilities_found'}
														<Badge variant="default" class="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
															<Bug class="w-3.5 h-3.5" />
														</Badge>
													{:else}
														{@const ExecBadgeIcon = badge.icon}
														<Badge variant={badge.variant} class={badge.class}>
															<ExecBadgeIcon class="w-3.5 h-3.5 {exec.status === 'running' ? 'animate-spin' : ''}" />
														</Badge>
													{/if}
												</Tooltip.Trigger>
												<Tooltip.Content side="left">
													<p class="whitespace-nowrap">{exec.details?.reason === 'vulnerabilities_found' ? 'Update blocked due to vulnerabilities' : (exec.status === 'skipped' ? 'Up-to-date' : exec.status)}</p>
												</Tooltip.Content>
											</Tooltip.Root>
										</td>
										<td class="px-2 py-1 text-xs text-destructive">
											{exec.errorMessage || ''}
										</td>
										<td class="px-2 py-1">
											<div class="flex items-center gap-1">
												<button
													type="button"
													onclick={() => loadExecutionDetail(exec.id)}
													title="View logs"
													class="p-0.5 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
												>
													<FileText class="w-3 h-3 text-muted-foreground hover:text-blue-500" />
												</button>
												<button
													type="button"
													onclick={() => deleteExecution(schedule, exec.id)}
													title="Delete execution"
													class="p-0.5 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
												>
													<Trash2 class="w-3 h-3 text-muted-foreground hover:text-red-500" />
												</button>
											</div>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
						{#if canLoadMore}
							<div class="flex justify-center py-4">
								<Button
									variant="outline"
									size="sm"
									disabled={isLoading}
									onclick={() => loadScheduleExecutions(schedule, executions.length)}
								>
									{#if isLoading}
										<Loader2 class="w-4 h-4 mr-2 animate-spin" />
										Loading...
									{:else}
										Load more
									{/if}
								</Button>
							</div>
						{/if}
					</div>
				{:else if isLoading}
					<div class="flex justify-center py-8">
						<Loader2 class="w-6 h-6 animate-spin text-muted-foreground" />
					</div>
				{:else}
					<p class="text-xs text-muted-foreground py-4">No executions found</p>
				{/if}
			</div>
		{/snippet}

		{#snippet emptyState()}
			<div class="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
				<Calendar class="w-12 h-12" />
				<p>No schedules found</p>
				<p class="text-xs">Enable auto-update on containers or auto-sync on git stacks to see them here</p>
			</div>
		{/snippet}
	</DataGrid>
</div>

<!-- Execution Detail Dialog -->
<Dialog.Root bind:open={showExecutionDialog}>
	<Dialog.Content class="max-w-5xl h-[85vh] overflow-hidden flex flex-col">
		<Dialog.Header class="flex flex-row items-center justify-between gap-4">
			<Dialog.Title class="flex items-center gap-2">
				{#if selectedExecution?.scheduleType === 'container_update'}
					<CircleArrowUp class="w-5 h-5 text-green-500 glow-green" />
				{:else if selectedExecution?.scheduleType === 'git_stack_sync'}
					<GitBranch class="w-5 h-5 text-emerald-500" />
				{:else if selectedExecution?.scheduleType === 'env_update_check'}
					{#if selectedExecution?.details?.autoUpdate}
						<CircleArrowUp class="w-5 h-5 text-green-500 glow-green" />
					{:else}
						<CircleFadingArrowUp class="w-5 h-5 text-green-500 glow-green" />
					{/if}
				{:else}
					<Wrench class="w-5 h-5 text-amber-500 drop-shadow-[0_0_3px_rgba(245,158,11,0.4)]" />
				{/if}
				Execution details
				{#if selectedExecution}
					<span class="text-muted-foreground font-normal">
						({#if selectedExecution.scheduleType === 'container_update'}Container update{:else if selectedExecution.scheduleType === 'env_update_check'}Environment update{:else if selectedExecution.scheduleType === 'git_stack_sync'}Git stack sync{:else}System job{/if})
					</span>
				{/if}
			</Dialog.Title>
			{#if selectedExecution}
				<span class="text-xs text-muted-foreground shrink-0 pr-6 whitespace-nowrap inline-flex items-center gap-1">
					{formatTimestamp(selectedExecution.triggeredAt)} · <Timer class="w-3 h-3 -mt-px" /> {formatDuration(selectedExecution.duration)}
				</span>
			{/if}
		</Dialog.Header>

		{#if loadingExecutionDetail}
			<div class="flex items-center justify-center py-8">
				<Loader2 class="w-8 h-8 animate-spin" />
			</div>
		{:else if selectedExecution}
			<div class="flex-1 flex flex-col min-h-0 space-y-4 overflow-hidden">
				<!-- Compact summary panel for env_update_check with autoUpdate -->
				{#if selectedExecution.scheduleType === 'env_update_check' && selectedExecution.details?.autoUpdate}
					<div class="shrink-0"><UpdateSummaryStats
						checked={selectedExecution.details.containersChecked ?? 0}
						updated={selectedExecution.details.updated ?? 0}
						blocked={selectedExecution.details.blocked ?? 0}
						failed={selectedExecution.details.failed ?? 0}
					/></div>
				{/if}

				<!-- Blocked containers list (scrollable) -->
				{#if selectedExecution.details?.blockedContainers?.length > 0}
					<div class="shrink-0">
						<div class="text-xs text-muted-foreground mb-1.5">Blocked containers</div>
						<div class="bg-amber-500/5 border border-amber-500/20 rounded-lg max-h-48 overflow-auto">
							<div class="divide-y divide-amber-500/10">
								{#each selectedExecution.details.blockedContainers as bc}
									<div class="flex items-center justify-between gap-3 p-2.5 text-xs">
										<div class="flex items-center gap-2 min-w-0">
											<ShieldX class="w-3.5 h-3.5 text-amber-500 shrink-0" />
											<span class="font-medium truncate">{bc.name}</span>
											<span class="text-muted-foreground shrink-0">- {bc.reason}</span>
										</div>
										{#if bc.scannerResults}
										<ScannerSeverityPills results={bc.scannerResults} />
									{/if}
									</div>
								{/each}
							</div>
						</div>
					</div>
				{/if}

				<!-- Execution info -->
				<div class="flex flex-wrap items-center gap-4 text-xs shrink-0">
					<div class="flex flex-wrap items-center gap-2">
						<span class="text-muted-foreground">Status</span>
						{#if selectedExecution.status}
							{@const badge = getStatusBadge(selectedExecution.status)}
							{@const envUpdateStatus = getEnvUpdateStatus(selectedExecution)}
							{@const isBlockedByVuln = selectedExecution.details?.reason === 'vulnerabilities_found'}
							{#if envUpdateStatus}
								{@const StatusIcon = envUpdateStatus.icon}
								<Badge variant="default" class={envUpdateStatus.class}>
									<StatusIcon class="w-3 h-3 mr-1" />
									<span>{envUpdateStatus.label}</span>
								</Badge>
							{:else if isBlockedByVuln}
								<Badge variant="default" class="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
									<Bug class="w-3 h-3 mr-1" />
									<span>Blocked</span>
								</Badge>
							{:else}
								{@const SelBadgeIcon = badge.icon}
								<Badge variant={badge.variant} class={badge.class}>
									<SelBadgeIcon class="w-3 h-3 mr-1" />
									<span class="capitalize">{selectedExecution.status === 'skipped' ? 'Up-to-date' : selectedExecution.status}</span>
								</Badge>
							{/if}
						{/if}
					</div>
					<div class="flex flex-wrap items-center gap-2">
						<span class="text-muted-foreground">Trigger</span>
						{#if selectedExecution.triggeredBy}
							{@const trigger = getTriggerBadge(selectedExecution.triggeredBy)}
							{@const SelTriggerIcon = trigger.icon}
							<Badge variant="default" class={trigger.class}>
								<SelTriggerIcon class="w-3.5 h-3.5 mr-1" />
								{trigger.label}
							</Badge>
						{/if}
					</div>
					{#if selectedExecution.details?.vulnerabilityCriteria}
						<div class="flex flex-wrap items-center gap-2">
							<span class="text-muted-foreground">Update block criteria</span>
							<VulnerabilityCriteriaBadge criteria={selectedExecution.details.vulnerabilityCriteria} showLabel />
						</div>
					{/if}
				</div>

				<!-- Block reason if update was blocked due to vulnerabilities -->
				{#if selectedExecution.details?.reason === 'vulnerabilities_found'}
					<div class="shrink-0">
						<div class="text-xs text-muted-foreground mb-1">Block reason</div>
						<div class="bg-amber-500/10 border border-amber-500/30 rounded p-3 text-xs text-amber-600 dark:text-amber-400 flex items-center gap-2">
							<Bug class="w-4 h-4 shrink-0" />
							<span>{selectedExecution.details.blockReason || 'Update blocked due to vulnerabilities'}</span>
						</div>
					</div>
				{/if}

				<!-- Scan results if available -->
				{#if selectedExecution.details?.scanResult?.summary}
					{@const summary = selectedExecution.details.scanResult.summary}
					{@const scannerResults = selectedExecution.details.scanResult.scannerResults}
					<div class="shrink-0">
						<div class="text-xs text-muted-foreground mb-1">Vulnerability scan results</div>
						<div class="border border-muted-foreground/20 rounded p-3">
							<div class="mb-2">
								<ScannerSeverityPills results={scannerResults ?? []} />
							</div>
							<div class="text-xs text-muted-foreground">
								Scanned with {selectedExecution.details.scanResult.scanners?.join(', ') || 'scanner'}
								{#if selectedExecution.details.scanResult.scannedAt}
									at {formatDateTime(selectedExecution.details.scanResult.scannedAt)}
								{/if}
							</div>
						</div>
					</div>
				{/if}

				<!-- Error message -->
				{#if selectedExecution.errorMessage}
					<div class="shrink-0">
						<div class="text-xs text-muted-foreground mb-1">Error</div>
						<div class="bg-destructive/10 border border-destructive/20 rounded p-3 text-xs text-destructive">
							{selectedExecution.errorMessage}
						</div>
					</div>
				{/if}

				<!-- Logs - fills remaining space -->
				<div class="flex-1 flex flex-col min-h-0">
					<ExecutionLogViewer
						logs={selectedExecution.logs}
						darkMode={logDarkMode}
						onToggleTheme={toggleLogTheme}
					/>
				</div>

			</div>
		{/if}
		<Dialog.Footer class="flex justify-end border-t pt-4">
			<Button onclick={() => showExecutionDialog = false}>OK</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
