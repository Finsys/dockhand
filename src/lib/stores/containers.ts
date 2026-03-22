import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';
import type { ContainerInfo, ContainerStats } from '$lib/types';
import { appendEnvParam, clearStaleEnvironment, environments } from '$lib/stores/environment';
import { toast } from 'svelte-sonner';

export interface AutoUpdateSetting {
	enabled: boolean;
	label: string;
	tooltip: string;
	vulnerabilityCriteria?: string;
}

export interface ContainerStoreState {
	/** Container list */
	data: ContainerInfo[];
	/** Live stats keyed by container ID */
	stats: Map<string, ContainerStats>;
	/** Previous stats snapshot for change detection */
	previousStats: Map<string, ContainerStats>;
	/** Auto-update settings keyed by container name */
	autoUpdateSettings: Map<string, AutoUpdateSetting>;
	/** Container IDs with pending updates */
	pendingUpdateIds: string[];
	/** Container names for pending updates, keyed by ID */
	pendingUpdateNames: Map<string, string>;
	/** Whether the current environment has vulnerability scanning */
	envHasScanning: boolean;
	/** Environment-level vulnerability criteria */
	envVulnerabilityCriteria: 'never' | 'any' | 'critical_high' | 'critical' | 'more_than_current';
	/** True during initial load (no cached data for this env) */
	loading: boolean;
	/** The environment ID this data belongs to */
	envId: number | null;
}

const INITIAL_STATE: ContainerStoreState = {
	data: [],
	stats: new Map(),
	previousStats: new Map(),
	autoUpdateSettings: new Map(),
	pendingUpdateIds: [],
	pendingUpdateNames: new Map(),
	envHasScanning: false,
	envVulnerabilityCriteria: 'never',
	loading: true,
	envId: null
};

function createContainerStore() {
	const { subscribe, set, update } = writable<ContainerStoreState>({ ...INITIAL_STATE });

	// In-flight request tracking to avoid duplicate concurrent fetches
	let fetchingContainers = false;
	let fetchingStats = false;

	function patch(partial: Partial<ContainerStoreState>) {
		update((s) => ({ ...s, ...partial }));
	}

	function formatSchedule(
		scheduleType: string,
		cronExpression: string
	): { label: string; tooltip: string } {
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
			return {
				label: dayName,
				tooltip: `Every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][parseInt(dow)] || dow} at ${timeStr}`
			};
		}

		return { label: 'cron', tooltip: cronExpression };
	}

	async function checkScannerSettings(envId: number | null) {
		if (!envId) {
			patch({ envHasScanning: false, envVulnerabilityCriteria: 'never' });
			return;
		}
		try {
			const [scannerResponse, updateCheckResponse] = await Promise.all([
				fetch(`/api/settings/scanner?env=${envId}&settingsOnly=true`),
				fetch(`/api/environments/${envId}/update-check`)
			]);

			let envHasScanning = false;
			let envVulnerabilityCriteria: ContainerStoreState['envVulnerabilityCriteria'] = 'never';

			if (scannerResponse.ok) {
				const data = await scannerResponse.json();
				const settings = data.settings || data;
				envHasScanning = settings.scanner !== 'none';
			}

			if (updateCheckResponse.ok) {
				const data = await updateCheckResponse.json();
				envVulnerabilityCriteria = data.settings?.vulnerabilityCriteria || 'never';
			}

			patch({ envHasScanning, envVulnerabilityCriteria });
		} catch {
			patch({ envHasScanning: false, envVulnerabilityCriteria: 'never' });
		}
	}

	async function fetchAutoUpdateSettings(envId: number | null) {
		const settings = new Map<string, AutoUpdateSetting>();
		const envParam = envId ? `?env=${envId}` : '';

		await checkScannerSettings(envId);

		try {
			const response = await fetch(`/api/auto-update${envParam}`);
			if (response.ok) {
				const data = await response.json();
				for (const [containerName, setting] of Object.entries(data)) {
					if (
						setting &&
						typeof setting === 'object' &&
						'enabled' in setting &&
						(setting as any).enabled
					) {
						const s = setting as {
							enabled: boolean;
							scheduleType: string;
							cronExpression: string | null;
							vulnerabilityCriteria: string;
						};
						const { label, tooltip } = formatSchedule(
							s.scheduleType,
							s.cronExpression || ''
						);
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

		patch({ autoUpdateSettings: settings });
	}

	async function fetchContainersInternal(envId: number | null) {
		if (!browser || !envId || fetchingContainers) return;
		fetchingContainers = true;

		const state = get({ subscribe });
		// Only show loading spinner if we have no cached data for this env
		const showLoading = state.data.length === 0 || state.envId !== envId;
		if (showLoading) {
			patch({ loading: true });
		}

		try {
			const response = await fetch(appendEnvParam('/api/containers', envId));
			if (!response.ok) {
				if (response.status === 404 && envId) {
					clearStaleEnvironment(envId);
					environments.refresh();
					return;
				}
				toast.error('Failed to load containers');
				return;
			}
			const data: ContainerInfo[] = await response.json();
			patch({ data, envId });

			// Fetch auto-update settings after containers load
			await fetchAutoUpdateSettings(envId);
		} catch (error) {
			console.error('Failed to fetch containers:', error);
			toast.error('Failed to load containers');
		} finally {
			patch({ loading: false });
			fetchingContainers = false;
		}
	}

	let statsAbortController: AbortController | null = null;

	async function fetchStatsInternal(envId: number | null) {
		if (!browser || !envId || fetchingStats) return;
		fetchingStats = true;

		// Abort any previous in-flight stream
		statsAbortController?.abort();
		statsAbortController = new AbortController();

		// Snapshot previous stats once at cycle start
		update((s) => ({ ...s, previousStats: new Map(s.stats) }));

		try {
			const response = await fetch(
				appendEnvParam('/api/containers/stats/stream', envId),
				{ signal: statsAbortController.signal }
			);

			if (!response.ok || !response.body) {
				return;
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				let currentEvent = '';
				for (const line of lines) {
					if (line.startsWith(':')) continue;

					if (line.startsWith('event: ')) {
						currentEvent = line.slice(7).trim();
					} else if (line.startsWith('data: ')) {
						if (currentEvent === 'stat') {
							try {
								const stat: ContainerStats = JSON.parse(line.slice(6));
								// Merge into existing stats map
								update((s) => {
									const newStats = new Map(s.stats);
									newStats.set(stat.id, stat);
									return { ...s, stats: newStats };
								});
							} catch {
								// Skip malformed data
							}
						}
						// done/error events — just let the loop finish
						currentEvent = '';
					}
				}
			}
		} catch (error: any) {
			if (error?.name !== 'AbortError') {
				console.error('Failed to fetch container stats:', error);
			}
		} finally {
			fetchingStats = false;
		}
	}

	async function loadPendingUpdatesInternal(envId: number | null) {
		if (!browser || !envId) return;
		try {
			const response = await fetch(appendEnvParam('/api/containers/pending-updates', envId));
			if (!response.ok) return;
			const data = await response.json();
			if (data.pendingUpdates && data.pendingUpdates.length > 0) {
				patch({
					pendingUpdateIds: data.pendingUpdates.map((u: any) => u.containerId),
					pendingUpdateNames: new Map(
						data.pendingUpdates.map((u: any) => [u.containerId, u.containerName])
					)
				});
			}
		} catch {
			// Ignore errors - background load
		}
	}

	return {
		subscribe,

		/** Full refresh: containers + auto-update settings */
		refreshContainers(envId: number | null) {
			return fetchContainersInternal(envId);
		},

		/** Stats-only refresh (called on 5s interval) */
		refreshStats(envId: number | null) {
			return fetchStatsInternal(envId);
		},

		/** Full refresh: containers + stats + settings + pending updates */
		async refresh(envId: number | null) {
			await Promise.all([
				fetchContainersInternal(envId),
				fetchStatsInternal(envId),
				loadPendingUpdatesInternal(envId)
			]);
		},

		/** Reload pending updates from database */
		loadPendingUpdates(envId: number | null) {
			return loadPendingUpdatesInternal(envId);
		},

		/** Clear all data (environment switch) */
		invalidate() {
			statsAbortController?.abort();
			fetchingStats = false;
			set({
				...INITIAL_STATE,
				loading: true
			});
		},

		/** Clear data without loading state (no environment selected) */
		clear() {
			statsAbortController?.abort();
			fetchingStats = false;
			set({ ...INITIAL_STATE, loading: false });
		},

		/** Update pending update IDs and names directly (from check-updates action) */
		setPendingUpdates(ids: string[], names: Map<string, string>) {
			patch({ pendingUpdateIds: ids, pendingUpdateNames: names });
		},

		/** Patch arbitrary fields */
		patch
	};
}

export const containerStore = createContainerStore();
