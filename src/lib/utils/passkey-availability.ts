/**
 * Whether this instance can offer passkey sign-in at all.
 *
 * Two independent reasons it cannot: an administrator turned it off, or the
 * deployment cannot satisfy WebAuthn (no ORIGIN, or an ORIGIN that is plain HTTP on
 * a real hostname). Either way the login page must not show a button that cannot
 * work - a dead affordance costs a user a cancelled browser prompt and tells them
 * nothing about why.
 *
 * Pure so both the server (deciding what to advertise) and the tests agree on the
 * rule without a database or a live request.
 */

/**
 * Read the stored `passkeys_enabled` setting.
 *
 * Absent or unreadable means OFF: passkeys need an ORIGIN the deployment may not have,
 * so an instance opts in once an administrator has somewhere for the credential to bind
 * to. Only an explicit true enables it.
 */
export function passkeysEnabledFromSetting(stored: unknown): boolean {
	return stored === true;
}

export interface PasskeyAvailability {
	/** The administrator's setting for this instance. */
	enabled: boolean;
	/** Whether ORIGIN is set to something WebAuthn accepts. */
	originUsable: boolean;
}

/** Whether the login page should offer passkey sign-in. */
export function passkeysOffered(state: PasskeyAvailability): boolean {
	return state.enabled && state.originUsable;
}
