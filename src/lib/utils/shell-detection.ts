import { appendEnvParam } from '$lib/stores/environment';

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
	{ value: '', label: 'Container default' }
];

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
 */
export function getBestShell(
	result: ShellDetectionResult,
	preferredShell: string
): string | null {
	// If preferred shell is available, use it
	if (result.shells.includes(preferredShell)) {
		return preferredShell;
	}
	// Otherwise use the default shell
	return result.defaultShell;
}

/**
 * Check if any shell is available
 */
export function hasAvailableShell(result: ShellDetectionResult): boolean {
	return result.shells.length > 0;
}
