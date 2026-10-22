/**
 * Whether the login page should go straight to the identity provider.
 *
 * Skipping the login form is a convenience for an instance where everyone signs in
 * the same way, and a trap everywhere else: an identity provider that is down, or a
 * redirect loop, must never make the login page unreachable. So the decision is
 * narrow on purpose, and every way of saying "not this time" wins.
 *
 * Pure, so the rules are a unit test rather than something only a broken provider
 * reveals.
 */

export interface AutoLoginInput {
	/** OIDC_AUTOLOGIN on the server. */
	enabled: boolean;
	/** Initiate URLs of the enabled OIDC providers. */
	oidcInitiateUrls: string[];
	/** An error carried back from a previous attempt, if any. */
	error?: string | null;
	/** `?local=1` on the login page: the operator asking for the form. */
	localRequested?: boolean;
}

/**
 * The URL to send the browser to, or null to render the login form.
 *
 * Requires exactly one provider: with two on screen there is a choice to make, and
 * choosing for the user is not a redirect, it is a decision.
 */
export function autoLoginTarget(input: AutoLoginInput): string | null {
	if (!input.enabled) return null;

	// A failed attempt leaves the form up, so one broken sign-in cannot become a
	// loop between here and the provider.
	if (input.error) return null;

	// The escape hatch an operator can type when the provider is unreachable.
	if (input.localRequested) return null;

	if (input.oidcInitiateUrls.length !== 1) return null;

	return input.oidcInitiateUrls[0];
}
