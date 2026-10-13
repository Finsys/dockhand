/**
 * What a verified id_token means, once the signature has been checked.
 *
 * Signature, issuer, audience and expiry are the library's job - they need network
 * access and a clock, and hand-rolling them is how this went wrong in the first place.
 * What is left is the part that decides who somebody is and what they may do, and that
 * part is worth being able to test exhaustively without an identity provider.
 *
 * Pure: no fetch, no database, no clock.
 */

/** Claims as they arrive, from the token or the userinfo response. */
export type Claims = Record<string, unknown>;

/**
 * Merge userinfo into the token's claims, refusing a response about somebody else.
 *
 * OIDC Core 5.3.2 requires the userinfo `sub` to match the id_token's. Without that
 * check the merge is an open door: userinfo values overwrite the token's, and the
 * admin claim is read afterwards, so a provider - or anything able to answer as one -
 * could hand out administrator rights through the weaker endpoint.
 */
export function mergeUserinfo(
	tokenClaims: Claims,
	userinfo: Claims | null | undefined
): MergeResult {
	if (!userinfo) return { ok: true, claims: tokenClaims };

	// Compared as text, because a provider that numbers its subjects may write the
	// same one as 12345 in the token and "12345" here.
	const tokenSub = subjectText(tokenClaims.sub);
	const infoSub = subjectText(userinfo.sub);

	// Two subjects that disagree is the attack: the token says one person, the
	// weaker endpoint says another, and the admin claim is read after the merge.
	if (infoSub !== undefined && tokenSub !== undefined && infoSub !== tokenSub) {
		return { ok: false, reason: 'subject-mismatch' };
	}

	// A response that names nobody cannot be tied to this token, but it is a poor
	// provider rather than an attack - and the token is already verified, so the
	// login continues on its claims alone.
	if (infoSub === undefined) {
		return { ok: true, claims: tokenClaims, ignored: 'no-subject' };
	}

	return { ok: true, claims: { ...tokenClaims, ...userinfo } };
}

/** A subject as comparable text, or undefined when the claim names nobody. */
function subjectText(value: unknown): string | undefined {
	if (typeof value === 'string' && value.length > 0) return value;
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	return undefined;
}

export type MergeResult =
	| { ok: true; claims: Claims; ignored?: 'no-subject' }
	| { ok: false; reason: 'subject-mismatch' };

/**
 * Whether the claims say this user is an administrator.
 *
 * Both the claim name and the accepted values come from the provider config; an
 * unconfigured pair grants nothing. The claim may be a single value or a list, and
 * the configured values are comma-separated, which is how the settings form presents
 * them.
 */
export function claimsGrantAdmin(
	claims: Claims,
	adminClaim: string | null | undefined,
	adminValue: string | null | undefined
): boolean {
	if (!adminClaim || !adminValue) return false;

	const wanted = adminValue
		.split(',')
		.map((v) => v.trim())
		.filter(Boolean);
	if (wanted.length === 0) return false;

	const actual = claims[adminClaim];
	if (Array.isArray(actual)) {
		return actual.some((v) => typeof v === 'string' && wanted.includes(v));
	}
	return typeof actual === 'string' && wanted.includes(actual);
}

/** The identity a login resolves to, or what was missing. */
export type IdentityResult =
	| { ok: true; username: string; email?: string; displayName?: string }
	| { ok: false; reason: 'no-username' };

/**
 * The account details carried by a set of claims.
 *
 * The username is the join key against local accounts, so a login without one cannot
 * proceed. `sub` is the last resort because it is the only claim a provider must
 * always send.
 */
export function identityFromClaims(
	claims: Claims,
	config: {
		usernameClaim?: string | null;
		emailClaim?: string | null;
		displayNameClaim?: string | null;
	}
): IdentityResult {
	const pick = (name: string | null | undefined, ...fallbacks: string[]): string | undefined => {
		const names = [name, ...fallbacks].filter((n): n is string => !!n);
		for (const n of names) {
			const v = claims[n];
			if (typeof v === 'string' && v.length > 0) return v;
			// Some providers number their subjects. The claims are verified by the
			// time they get here, so a numeric one is as trustworthy as a written one
			// and refusing it would lock those users out for a formatting detail.
			if (typeof v === 'number' && Number.isFinite(v)) return String(v);
		}
		return undefined;
	};

	const username = pick(config.usernameClaim, 'preferred_username', 'sub');
	if (!username) return { ok: false, reason: 'no-username' };

	return {
		ok: true,
		username,
		email: pick(config.emailClaim, 'email'),
		displayName: pick(config.displayNameClaim, 'name')
	};
}

/** A role the provider's claims ask for. */
export interface RoleMapping {
	claimValue: string;
	roleId: number;
}

/**
 * The roles a set of claims asks for, from the configured mappings.
 *
 * Returns role ids rather than assigning anything, so the caller decides what to do
 * with them and the matching stays testable.
 */
export function rolesFromClaims(
	claims: Claims,
	mappings: RoleMapping[] | null | undefined,
	claimName: string | null | undefined
): number[] {
	if (!mappings || mappings.length === 0) return [];

	const actual = claims[claimName || 'groups'];
	const values = Array.isArray(actual)
		? actual.filter((v): v is string => typeof v === 'string')
		: typeof actual === 'string'
			? [actual]
			: [];
	if (values.length === 0) return [];

	// The mappings arrive from JSON in the provider row, so the shape is a claim, not
	// a guarantee. A mapping pointing at no real role is dropped rather than turned
	// into a bad write.
	const ids = mappings
		.filter((m) => m && values.includes(m.claimValue))
		.map((m) => m.roleId)
		.filter((id): id is number => Number.isInteger(id) && id > 0);
	return [...new Set(ids)];
}
