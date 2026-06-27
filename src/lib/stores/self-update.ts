/**
 * Session-scoped Dockhand self-update check.
 *
 * Fires once per browser session (first sidebar mount). The result is shared
 * across every consumer (sidebar indicator, Settings → About) so we never
 * hit the registry more than once unless the user clicks "Check now."
 *
 * Endpoint requires admin; non-admin users see {error, updateAvailable: false}
 * and the consumers render nothing. No retry, no polling.
 */
import { writable } from 'svelte/store';
import { browser } from '$app/environment';

export interface SelfUpdateState {
	checked: boolean;
	updateAvailable: boolean;
	currentImage?: string;
	currentDigest?: string;
	registryDigest?: string;
	/** Parsed semver like "1.0.36" — present when latestVersion came back from the server. */
	latestVersion?: string;
	/** Resolved newer image tag (registry/repo:newTag). */
	newImage?: string;
}

const initial: SelfUpdateState = {
	checked: false,
	updateAvailable: false
};

function createStore() {
	const { subscribe, set } = writable<SelfUpdateState>(initial);
	let inFlight: Promise<void> | null = null;
	let didCheck = false;

	async function checkOnce(force = false): Promise<void> {
		if (!browser) return;
		if (inFlight) return inFlight;
		if (didCheck && !force) return;

		inFlight = (async () => {
			try {
				const res = await fetch('/api/self-update/check', {
					headers: force ? { 'Cache-Control': 'no-cache' } : undefined
				});
				if (!res.ok) {
					set({ ...initial, checked: true });
					return;
				}
				const data = await res.json();
				set({
					checked: true,
					updateAvailable: !!data.updateAvailable,
					currentImage: data.currentImage,
					currentDigest: data.currentDigest,
					registryDigest: data.registryDigest,
					latestVersion: data.latestVersion,
					newImage: data.newImage
				});
			} catch {
				set({ ...initial, checked: true });
			} finally {
				didCheck = true;
				inFlight = null;
			}
		})();

		return inFlight;
	}

	return {
		subscribe,
		checkOnce,
		/** Force a fresh check (e.g. user clicked "Check now" in About). */
		refresh: () => checkOnce(true),
		/** Hand-set the result when a caller already fetched it (avoids
		 *  a duplicate /api/self-update/check on the wire). */
		setFromResponse: (data: {
			updateAvailable?: boolean;
			currentImage?: string;
			currentDigest?: string;
			registryDigest?: string;
			latestVersion?: string;
			newImage?: string;
		}) =>
			set({
				checked: true,
				updateAvailable: !!data.updateAvailable,
				currentImage: data.currentImage,
				currentDigest: data.currentDigest,
				registryDigest: data.registryDigest,
				latestVersion: data.latestVersion,
				newImage: data.newImage
			})
	};
}

export const selfUpdate = createStore();
