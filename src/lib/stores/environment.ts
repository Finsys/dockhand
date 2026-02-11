import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';

export interface CurrentEnvironment {
	id: number;
	name: string;
	highlightChanges?: boolean;
}

export interface Environment {
	id: number;
	name: string;
	icon?: string;
	host?: string;
	port?: number;
	protocol?: string;
	socketPath?: string;
	connectionType?: 'socket' | 'direct' | 'hawser-standard' | 'hawser-edge';
	publicIp?: string | null;
}

const STORAGE_KEY = 'dockhand:environment';

// Load initial state from localStorage
function getInitialEnvironment(): CurrentEnvironment | null {
	if (browser) {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored) {
			try {
				return JSON.parse(stored);
			} catch {
				return null;
			}
		}
	}
	return null;
}

// Create a writable store for the current environment
function createEnvironmentStore() {
	const { subscribe, set, update } = writable<CurrentEnvironment | null>(getInitialEnvironment());

	return {
		subscribe,
		set: (value: CurrentEnvironment | null) => {
			if (browser) {
				if (value) {
					localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
				} else {
					localStorage.removeItem(STORAGE_KEY);
				}
			}
			set(value);
		},
		update
	};
}

export const currentEnvironment = createEnvironmentStore();

/**
 * Call this when an API returns 404 for the current environment.
 * Clears the stale environment from localStorage and store.
 */
export function clearStaleEnvironment(envId: number) {
	if (browser) {
		const current = get(currentEnvironment);
		// Use Number() for type-safe comparison
		if (current && Number(current.id) === Number(envId)) {
			console.warn(`Environment ${envId} no longer exists, clearing from localStorage`);
			currentEnvironment.set(null);
		}
	}
}

// Helper to get the environment ID for API calls
export function getEnvParam(envId: number | null | undefined): string {
	return envId ? `?env=${envId}` : '';
}

// Helper to append env param to existing URL
export function appendEnvParam(url: string, envId: number | null | undefined): string {
	if (!envId) return url;
	const separator = url.includes('?') ? '&' : '?';
	return `${url}${separator}env=${envId}`;
}

// Store for environments list with auto-refresh capability
function createEnvironmentsStore() {
	const { subscribe, set, update } = writable<Environment[]>([]);
	const loaded = writable<boolean>(false); // Tracks if environments have been fetched at least once
	let loading = false;

	async function fetchEnvironments() {
		if (!browser || loading) return;
		loading = true;
		try {
			const response = await fetch('/api/environments');
			if (response.ok) {
				const data: Environment[] = await response.json();
				set(data);
				loaded.set(true);

				// Auto-select environment if none selected or current one no longer exists
				const current = get(currentEnvironment);
				// Use Number() to handle any potential type mismatches from localStorage
				const currentId = current ? Number(current.id) : null;
				const currentExists = currentId !== null && data.some((e) => Number(e.id) === currentId);

				console.log(`[EnvStore] refresh: current=${currentId}, exists=${currentExists}, envCount=${data.length}`);

				if (data.length === 0) {
					// No environments left - clear selection
					console.log('[EnvStore] No environments, clearing selection');
					currentEnvironment.set(null);
				} else if (!current) {
					// No selection - select first
					console.log(`[EnvStore] No current env, selecting first: ${data[0].name}`);
					const firstEnv = data[0];
					currentEnvironment.set({
						id: firstEnv.id,
						name: firstEnv.name
					});
				} else if (!currentExists) {
					// Current env was deleted - select first
					console.warn(`[EnvStore] Environment ${currentId} no longer exists in list, selecting first: ${data[0].name}`);
					const firstEnv = data[0];
					currentEnvironment.set({
						id: firstEnv.id,
						name: firstEnv.name
					});
				} else {
					console.log(`[EnvStore] Current env ${currentId} still exists, keeping selection`);
				}
			} else {
				// Clear environments on permission denied or other errors
				set([]);
				loaded.set(true); // Mark as loaded even on error - we've completed the fetch
				// Also clear the current environment from localStorage
				localStorage.removeItem(STORAGE_KEY);
				currentEnvironment.set(null);
			}
		} catch (error) {
			console.error('Failed to fetch environments:', error);
			set([]);
			loaded.set(true); // Mark as loaded even on error - we've completed the fetch
			localStorage.removeItem(STORAGE_KEY);
			currentEnvironment.set(null);
		} finally {
			loading = false;
		}
	}

	// Auto-fetch on browser load
	if (browser) {
		fetchEnvironments();
	}

	return {
		subscribe,
		refresh: fetchEnvironments,
		set,
		update,
		loaded, // Expose the loaded store for consumers to know when first fetch is complete
		/**
		 * Clear all environment data (used on logout)
		 */
		clear: () => {
			set([]);
			loaded.set(false);
			if (browser) {
				localStorage.removeItem(STORAGE_KEY);
			}
			currentEnvironment.set(null);
		}
	};
}

export const environments = createEnvironmentsStore();
