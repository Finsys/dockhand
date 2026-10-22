/**
 * The three questions a stored license answers, which are not the same question.
 *
 * "Does this instance enforce roles?" and "is the customer paid up?" used to be one
 * flag, so an expiry switched the whole instance to the free edition - where every
 * authenticated user has full access - and silently promoted every account to
 * administrator. Keeping them apart means an expiry changes who may act without
 * changing how authorization works.
 *
 *   enforcesRoles          - roles exist and are checked. Survives an expiry.
 *   licenseValid           - the paid features are available. Does not.
 *   lapsed                 - installed but no longer valid: hold everyone but admins.
 *
 * Pure, so the matrix is a unit test rather than something only an expired key shows.
 */

/** As much of a validated license as these decisions need. */
export interface LicenseVerdict {
	valid: boolean;
	active: boolean;
	/** Absent when the key was missing, malformed, or failed its signature check. */
	payload?: { type?: string };
}

/** A signed enterprise key, whether or not it still validates. */
function isEnterpriseKey(verdict: LicenseVerdict | null | undefined): boolean {
	return verdict?.payload?.type === 'enterprise';
}

/**
 * Whether roles exist and are enforced.
 *
 * True for an enterprise key even once it has lapsed: the roles are still assigned, and
 * dozens of endpoints gate environment access on this flag. Dropping it on an expiry
 * would turn every one of those checks off at once.
 */
export function enforcesRoles(verdict: LicenseVerdict | null | undefined): boolean {
	return isEnterpriseKey(verdict);
}

/**
 * Whether the enterprise features are available to sell.
 *
 * The question to ask when gating LDAP, the audit log, or role editing - things a
 * customer stops being entitled to the moment the license stops validating.
 */
export function licenseValid(verdict: LicenseVerdict | null | undefined): boolean {
	return !!verdict && verdict.valid && verdict.active && isEnterpriseKey(verdict);
}

/**
 * Whether an enterprise license is installed but no longer validates.
 *
 * Only a genuine enterprise key reaches this: the signature is checked before the
 * payload is trusted, so a forged or corrupt key leaves nothing to claim enterprise
 * with. Otherwise anyone able to write the setting could lock the instance out with a
 * junk string. An expired SMB key is not a lapse either - SMB never unlocked roles.
 */
export function lapsed(verdict: LicenseVerdict | null | undefined): boolean {
	if (!verdict) return false;
	if (verdict.valid && verdict.active) return false;
	return isEnterpriseKey(verdict);
}

/**
 * Whether a non-administrator may act, given the license state.
 *
 * Administrators are decided before this is asked, so it answers only for everybody
 * else: a lapse holds them until a valid license is installed, and every other state
 * leaves them to their roles.
 */
export function nonAdminMayAct(verdict: LicenseVerdict | null | undefined): boolean {
	return !lapsed(verdict);
}
