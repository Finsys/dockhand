import { appendEnvParam } from '$lib/stores/environment';
import { m } from '$lib/paraglide/messages.js';

export interface ShellInfo {
	path: string;
	label: string;
	available: boolean;
}

export const SHELL_OPTIONS: Omit<ShellInfo, 'available'>[] = [
	{ path: '/bin/bash', label: 'Bash' },
	{ path: '/bin/sh', label: 'Shell (sh)' },
	{ path: '/bin/zsh', label: 'Zsh' },
	{ path: '/bin/ash', label: 'Ash (Alpine)' }
];

export const USER_OPTIONS = [
	{ value: 'root', label: 'root' },
	{ value: 'nobody', label: 'nobody' },
	// Getter, so the label is read in the active locale when rendered
	{
		value: '',
		get label() {
			return m.shell_user_container_default();
		}
	}
];

const TERMINAL_USER_STORAGE_KEY = 'dockhand-terminal-users';
const CUSTOM_USERS_STORAGE_KEY = 'dockhand-custom-users';

/** Get saved user for a container from localStorage */
export function getSavedUser(containerId: string): string | null {
	if (typeof window === 'undefined') return null;
	try {
		const stored = localStorage.getItem(TERMINAL_USER_STORAGE_KEY);
		if (stored) {
			const map = JSON.parse(stored) as Record<string, string>;
			return map[containerId] ?? null;
		}
	} catch { /* ignore */ }
	return null;
}

/** Save user choice for a container to localStorage */
export function saveUserForContainer(containerId: string, user: string) {
	if (typeof window === 'undefined') return;
	try {
		const stored = localStorage.getItem(TERMINAL_USER_STORAGE_KEY);
		const map = stored ? JSON.parse(stored) as Record<string, string> : {};
		if (user === 'root') {
			delete map[containerId];
		} else {
			map[containerId] = user;
		}
		localStorage.setItem(TERMINAL_USER_STORAGE_KEY, JSON.stringify(map));
	} catch { /* ignore */ }

	// Also track custom users globally
	const isPreset = USER_OPTIONS.some(o => o.value === user);
	if (!isPreset && user) {
		addCustomUser(user);
	}
}

/** Get all custom users ever used */
export function getCustomUsers(): string[] {
	if (typeof window === 'undefined') return [];
	try {
		const stored = localStorage.getItem(CUSTOM_USERS_STORAGE_KEY);
		return stored ? JSON.parse(stored) : [];
	} catch { return []; }
}

/** Add a custom user to the global list */
function addCustomUser(user: string) {
	if (typeof window === 'undefined') return;
	try {
		const users = getCustomUsers();
		if (!users.includes(user)) {
			users.push(user);
			localStorage.setItem(CUSTOM_USERS_STORAGE_KEY, JSON.stringify(users));
		}
	} catch { /* ignore */ }
}

/** Remove a custom user from the global list and clear per-container references */
export function removeCustomUser(user: string) {
	if (typeof window === 'undefined') return;
	try {
		const users = getCustomUsers().filter(u => u !== user);
		localStorage.setItem(CUSTOM_USERS_STORAGE_KEY, JSON.stringify(users));

		// Clear per-container entries that reference this user
		const stored = localStorage.getItem(TERMINAL_USER_STORAGE_KEY);
		if (stored) {
			const map = JSON.parse(stored) as Record<string, string>;
			for (const [id, u] of Object.entries(map)) {
				if (u === user) delete map[id];
			}
			localStorage.setItem(TERMINAL_USER_STORAGE_KEY, JSON.stringify(map));
		}
	} catch { /* ignore */ }
}

export interface ShellDetectionResult {
	shells: string[];
	defaultShell: string | null;
	allShells: ShellInfo[];
	error?: string;
}

/**
 * Detect available shells in a container
 */
export async function detectShells(
	containerId: string,
	envId: number | null
): Promise<ShellDetectionResult> {
	try {
		const response = await fetch(
			appendEnvParam(`/api/containers/${containerId}/shells`, envId)
		);
		const data = await response.json();
		return {
			shells: data.shells || [],
			defaultShell: data.defaultShell || null,
			allShells: data.allShells || SHELL_OPTIONS.map(s => ({ ...s, available: false })),
			error: data.error
		};
	} catch (error) {
		console.error('Failed to detect shells:', error);
		return {
			shells: [],
			defaultShell: null,
			allShells: SHELL_OPTIONS.map(s => ({ ...s, available: false })),
			error: 'Failed to detect available shells'
		};
	}
}

/**
 * Get the best available shell from the detection result
 * Returns the user's preferred shell if available, otherwise the default
 *
 * Preference matching is by shell name (basename), not full path — so a
 * preference of `/bin/bash` will still match when the server resolved bash
 * to a non-standard path like `/usr/bin/bash` (issue #1189).
 */
export function getBestShell(
	result: ShellDetectionResult,
	preferredShell: string
): string | null {
	const exact = result.shells.find(s => s === preferredShell);
	if (exact) return exact;

	const preferredName = preferredShell.split('/').pop();
	if (preferredName) {
		const byName = result.shells.find(s => s.split('/').pop() === preferredName);
		if (byName) return byName;
	}

	return result.defaultShell;
}

/**
 * Check if any shell is available
 */
export function hasAvailableShell(result: ShellDetectionResult): boolean {
	return result.shells.length > 0;
}
