/**
 * A saved list order, kept per user.
 *
 * The server copy is the durable one; localStorage holds a mirror so the first
 * paint uses the saved order instead of flashing the default one. Both the
 * environment list and the tag catalogue order are built from this.
 */

import { writable } from 'svelte/store';

export interface IdOrderStoreOptions {
	/** localStorage key for the mirror. */
	storageKey: string;
	/** Endpoint serving GET / POST / DELETE of `{ order: number[] }`. */
	endpoint: string;
}

function loadFromStorage(key: string): number[] {
	if (typeof window === 'undefined') return [];
	try {
		const stored = localStorage.getItem(key);
		const parsed = stored ? JSON.parse(stored) : null;
		if (Array.isArray(parsed) && parsed.every((id) => typeof id === 'number')) return parsed;
	} catch {
		// Ignore parse errors - fall back to the default order
	}
	return [];
}

function saveToStorage(key: string, order: number[]) {
	if (typeof window === 'undefined') return;
	try {
		localStorage.setItem(key, JSON.stringify(order));
	} catch {
		// Ignore storage errors - the server copy is the durable one
	}
}

export function createIdOrderStore({ storageKey, endpoint }: IdOrderStoreOptions) {
	const { subscribe, set } = writable<number[]>(loadFromStorage(storageKey));
	let loading: Promise<void> | null = null;

	async function fetchOrder() {
		try {
			const res = await fetch(endpoint);
			if (!res.ok) return;
			const data = await res.json();
			const order = Array.isArray(data.order) ? data.order : [];
			set(order);
			saveToStorage(storageKey, order);
		} catch {
			// Offline or unauthenticated: the localStorage copy stands
		}
	}

	return {
		/**
		 * Reading the store fetches the server copy the first time, so a screen that
		 * only ever displays the order cannot show a stale one - and a drag there
		 * cannot save over the real order with a default-ordered baseline.
		 */
		subscribe(...args: Parameters<typeof subscribe>) {
			if (typeof window !== 'undefined' && !loading) loading = fetchOrder();
			return subscribe(...args);
		},

		/** Re-read the server copy - after a sign-in it belongs to someone else. */
		async init() {
			loading = fetchOrder();
			await loading;
		},

		/**
		 * Optimistic save - the list reorders immediately, the server catches up.
		 * Waits for a first read still in flight, so a drag made before the saved
		 * order arrived cannot overwrite it with a default-ordered baseline.
		 */
		async save(order: number[]) {
			if (loading) await loading;
			// This IS the current order now, so a later first read must not fetch an
			// older one over the top of it.
			loading = Promise.resolve();
			set(order);
			saveToStorage(storageKey, order);
			try {
				await fetch(endpoint, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ order })
				});
			} catch {
				// Silently fail - localStorage holds the value until the next save
			}
		},

		/** Back to the server's own order. */
		async reset() {
			set([]);
			if (typeof window !== 'undefined') {
				try {
					localStorage.removeItem(storageKey);
				} catch {
					// Ignore storage errors
				}
			}
			try {
				await fetch(endpoint, { method: 'DELETE' });
			} catch {
				// Silently fail
			}
		},

		/** Drop the local copy on logout, so the next user starts from theirs. */
		clearLocal() {
			// The next user on this browser gets their own order, not this one.
			loading = null;
			set([]);
			if (typeof window !== 'undefined') {
				try {
					localStorage.removeItem(storageKey);
				} catch {
					// Ignore storage errors
				}
			}
		}
	};
}
