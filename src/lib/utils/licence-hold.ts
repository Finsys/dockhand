/**
 * Whether a lapsed licence is what is holding this account back.
 *
 * When an enterprise licence stops validating, the roles it configured keep their
 * shape but nobody except an administrator may act on them, so every screen answers
 * the same refusal at once. Read one screen at a time that looks like a broken
 * application: an empty table, a spinner that never resolves, a failed request. Said
 * once, at the top, it is a sentence anybody can act on.
 *
 * Pure, so the rule is a unit test rather than something only an expiry reveals.
 */

export interface LicenceHoldInput {
	/** An enterprise licence is installed, whether or not it still validates. */
	hasEnterpriseLicense: boolean;
	/** Whether that licence currently validates. */
	isEnterprise: boolean;
	/** Whether the signed-in account is an administrator. */
	isAdmin: boolean;
	/** Whether anybody is signed in at all. */
	isAuthenticated: boolean;
	/** Whether both the licence and the account are still being read. */
	loading?: boolean;
}

/**
 * True when this account is refused everywhere because the licence lapsed.
 *
 * Deliberately narrow. An administrator still works and needs no banner - they are
 * the one who fixes it. Nobody signed in has a login page to look at instead, and an
 * instance that never had an enterprise licence is not on hold, it is simply free.
 */
export function heldByLapsedLicence(state: LicenceHoldInput): boolean {
	// The licence and the account are read in two separate requests. Answering before
	// both are back would tell an administrator, for as long as the slower request
	// takes, that they cannot make changes - which is both wrong and the opposite of
	// what they need to see.
	if (state.loading) return false;
	if (!state.isAuthenticated) return false;
	if (state.isAdmin) return false;
	// Installed but no longer validating is exactly the hold; never installed is not.
	return state.hasEnterpriseLicense && !state.isEnterprise;
}

/** What to tell somebody who is held, or null when they are not. */
export function licenceHoldMessage(state: LicenceHoldInput): string | null {
	if (!heldByLapsedLicence(state)) return null;
	return 'This instance needs its licence renewed. Until then only administrators can make changes, so pages will look empty.';
}
