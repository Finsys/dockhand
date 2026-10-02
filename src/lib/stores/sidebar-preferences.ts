/**
 * Sidebar Menu Preferences Store for Dockhand
 *
 * Manages sidebar item order and visibility with:
 * - localStorage sync for flash-free loading
 * - Database persistence via API (app-wide without auth, per-user with auth)
 */

import { writable } from 'svelte/store';
import { applyOrder } from '$lib/utils/apply-order';

export interface SidebarPreferences {
	order: string[];
	hidden: string[];
}

const STORAGE_KEY = 'dockhand-sidebar-preferences';

const DEFAULTS: SidebarPreferences = { order: [], hidden: [] };

// Load initial state from localStorage
function loadFromStorage(): SidebarPreferences {
	if (typeof window === 'undefined') return DEFAULTS;

	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored) {
			const parsed = JSON.parse(stored);
			if (Array.isArray(parsed?.order) && Array.isArray(parsed?.hidden)) {
				return parsed;
			}
		}
	} catch {
		// Ignore parse errors
	}
	return DEFAULTS;
}

// Save to localStorage
function saveToStorage(prefs: SidebarPreferences) {
	if (typeof window === 'undefined') return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
	} catch {
		// Ignore storage errors
	}
}

/** Apply a saved order to the default menu item list, keyed by href. */
export function orderItems<T extends { href: string }>(items: readonly T[], order: string[]): T[] {
	return applyOrder(items, order, (item) => item.href);
}

/**
 * Splice a reordered visible list back into the full order.
 *
 * The drag list only ever holds the items a user may see, so the entries hidden
 * by permission or licence keep the slots they already occupy; replacing the
 * full order with the visible one would drop them.
 */
export function mergeVisibleOrder(fullOrder: string[], visibleOrder: string[]): string[] {
	const visible = new Set(visibleOrder);
	let next = 0;
	return fullOrder.map((href) => (visible.has(href) ? visibleOrder[next++] : href));
}

function createSidebarPreferencesStore() {
	const { subscribe, set } = writable<SidebarPreferences>(loadFromStorage());

	return {
		subscribe,

		// Initialize from API (called on mount) - server value wins
		async init() {
			try {
				const res = await fetch('/api/preferences/sidebar');
				if (res.ok) {
					const data = await res.json();
					const prefs = { ...DEFAULTS, ...(data.preferences || {}) };
					set(prefs);
					saveToStorage(prefs);
				}
			} catch {
				// Use localStorage fallback
			}
		},

		// Optimistic update + async persistence
		async save(prefs: SidebarPreferences) {
			set(prefs);
			saveToStorage(prefs);

			try {
				await fetch('/api/preferences/sidebar', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(prefs)
				});
			} catch {
				// Silently fail - localStorage has the value
			}
		},

		// Reset to default order/visibility
		async reset() {
			set(DEFAULTS);
			if (typeof window !== 'undefined') {
				try {
					localStorage.removeItem(STORAGE_KEY);
				} catch {
					// Ignore storage errors
				}
			}

			try {
				await fetch('/api/preferences/sidebar', { method: 'DELETE' });
			} catch {
				// Silently fail
			}
		},

		// Drop the localStorage copy (on logout, so the next user on this
		// browser doesn't briefly see the previous user's layout)
		clearLocal() {
			set(DEFAULTS);
			if (typeof window !== 'undefined') {
				try {
					localStorage.removeItem(STORAGE_KEY);
				} catch {
					// Ignore storage errors
				}
			}
		}
	};
}

export const sidebarPreferencesStore = createSidebarPreferencesStore();
