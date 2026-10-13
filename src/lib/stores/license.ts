import { writable, derived, readable } from 'svelte/store';
import { browser } from '$app/environment';
import { daysLeft, deriveLicenceFlags, expiryParts, licenceHeaderParts } from '$lib/utils/license-expiry-text';
import { m } from '$lib/paraglide/messages.js';

export type LicenseType = 'enterprise' | 'smb';

export interface LicenseState {
	isEnterprise: boolean;
	/** An enterprise licence is installed, whether or not it is still valid. */
	hasEnterpriseLicense: boolean;
	/** Why the licence does not validate, as the server put it. Null when it does. */
	problem: string | null;
	isLicensed: boolean;
	licenseType: LicenseType | null;
	loading: boolean;
	licensedTo: string | null;
	expiresAt: string | null;
}

function createLicenseStore() {
	const { subscribe, set, update } = writable<LicenseState>({
		isEnterprise: false,
		hasEnterpriseLicense: false,
		problem: null,
		isLicensed: false,
		licenseType: null,
		loading: true,
		licensedTo: null,
		expiresAt: null
	});

	async function check() {
		update(state => ({ ...state, loading: true }));
		try {
			const response = await fetch('/api/license');
			const data = await response.json();
			const flags = deriveLicenceFlags(data);
			set({
				...flags,
				licenseType: flags.licenseType as LicenseType | null,
				loading: false,
				licensedTo: data.stored?.name || null
			});
		} catch {
			set({ isEnterprise: false, hasEnterpriseLicense: false, problem: null, isLicensed: false, licenseType: null, loading: false, licensedTo: null, expiresAt: null });
		}
	}

	return {
		subscribe,
		check,
		/**
		 * Re-read the licence when somebody comes back to the page.
		 *
		 * Whether a licence EXISTS is the server's answer, unlike how long is left,
		 * which the browser can work out for itself. A licence activated in another
		 * tab, or by an administrator elsewhere, is only visible after asking again.
		 * Returns a function that stops listening.
		 */
		watchForChanges(): () => void {
			if (!browser) return () => {};

			const recheck = () => {
				if (!document.hidden) check();
			};

			document.addEventListener('visibilitychange', recheck);
			window.addEventListener('focus', recheck);

			return () => {
				document.removeEventListener('visibilitychange', recheck);
				window.removeEventListener('focus', recheck);
			};
		},
		setEnterprise(value: boolean) {
			update(state => ({ ...state, isEnterprise: value }));
		},
		/** Wait for the store to finish loading */
		waitUntilLoaded(): Promise<LicenseState> {
			return new Promise((resolve) => {
				const unsubscribe = subscribe((state) => {
					if (!state.loading) {
						// Use setTimeout to avoid unsubscribing during callback
						setTimeout(() => unsubscribe(), 0);
						resolve(state);
					}
				});
			});
		}
	};
}

export const licenseStore = createLicenseStore();

/**
 * The current time, re-read whenever somebody comes back to the page.
 *
 * "How long is left" is arithmetic on a date the browser already holds, so it needs no
 * request - only a fresh reading of the clock. Taking it on focus and on tab
 * visibility covers coming back to a window left open, which is when a stale countdown
 * would otherwise be believed. There is deliberately no timer: a page nobody is
 * looking at has nothing to update, and the listeners only exist while something is
 * actually subscribed.
 */
const clock = readable(Date.now(), (set) => {
	if (!browser) return;

	const read = () => set(Date.now());
	const onVisible = () => {
		if (!document.hidden) read();
	};

	document.addEventListener('visibilitychange', onVisible);
	window.addEventListener('focus', read);

	return () => {
		document.removeEventListener('visibilitychange', onVisible);
		window.removeEventListener('focus', read);
	};
});

/** Milliseconds until the licence expires; negative once it has. Null when unlicensed. */
export const msUntilExpiry = derived([licenseStore, clock], ([$license, $clock]) => {
	// Keyed on the date being there rather than on the licence still being valid: the
	// countdown has to survive the moment it reaches zero, or the warning vanishes
	// exactly when it becomes true.
	if (!$license.expiresAt) return null;
	return new Date($license.expiresAt).getTime() - $clock;
});

/** Whole days left, used to decide whether to warn and how loudly. */
export const daysUntilExpiry = derived(msUntilExpiry, ($ms) =>
	$ms === null ? null : daysLeft($ms)
);

/**
 * What the header says about the time left, or null when there is nothing to say.
 * Same decision as licenceHeaderText (utils/license-expiry-text), worded in the UI language.
 */
export const expiryMessage = derived([licenseStore, msUntilExpiry], ([$license, $ms]) => {
	const parts = licenceHeaderParts({
		hasEnterpriseLicense: $license.hasEnterpriseLicense,
		isEnterprise: $license.isEnterprise,
		msRemaining: $ms,
		problem: $license.problem
	});
	if (!parts) return null;
	if (parts.kind === 'problem') return m.licence_problem({ problem: parts.problem });
	if (parts.kind === 'invalid') return m.licence_not_valid();
	const expiry = expiryParts(parts.msRemaining);
	switch (expiry.unit) {
		case 'expired':
			return m.licence_expired();
		case 'minutes':
			return m.licence_expires_minutes({ count: expiry.count });
		case 'hours':
			return m.licence_expires_hours({ count: expiry.count });
		case 'tomorrow':
			return m.licence_expires_tomorrow();
		case 'days':
			return m.licence_expires_days({ count: expiry.count });
	}
});
