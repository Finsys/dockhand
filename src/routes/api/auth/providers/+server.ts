import { json } from '@sveltejs/kit';
import { autoLoginTarget } from '$lib/utils/oidc-autologin';
import type { RequestHandler } from '@sveltejs/kit';
import { isAuthEnabled, getEnabledLdapConfigs, getEnabledOidcConfigs } from '$lib/server/auth';
import { getAuthSettings, getPasskeysEnabled } from '$lib/server/db';
import { isEnterprise } from '$lib/server/license';
import { isWebAuthnConfigured } from '$lib/server/webauthn';
import { passkeysOffered } from '$lib/utils/passkey-availability';

// GET /api/auth/providers - Get available authentication providers
/**
 * @openapi
 * summary: List the authentication providers offered on the login page (local, LDAP, OIDC), plus the default provider
 * resp-200: {providers:array<{id:string!, name:string!, type:string!, initiateUrl:string}>, defaultProvider:string, passkeys:boolean, autoLoginUrl:string}
 * resp-200-desc: passkeys says whether to offer passkey sign-in - true only when an administrator has it enabled AND ORIGIN allows a WebAuthn ceremony. autoLoginUrl is present only when OIDC_AUTOLOGIN is set and exactly one OIDC provider is enabled; the login page then goes straight there
 * resp-200-example: {"providers":[{"id":"local","name":"Local","type":"local"},{"id":"oidc:1","name":"Authentik","type":"oidc","initiateUrl":"/api/auth/oidc/1/initiate"}],"defaultProvider":"local","passkeys":true}
 */
export const GET: RequestHandler = async () => {
	if (!(await isAuthEnabled())) {
		return json({ providers: [] });
	}

	try {
		// Fetch all provider configs in parallel
		const [settings, enterpriseEnabled, oidcConfigs, passkeysEnabled] = await Promise.all([
			getAuthSettings(),
			isEnterprise(),
			getEnabledOidcConfigs(),
			getPasskeysEnabled()
		]);
		const ldapConfigs = enterpriseEnabled ? await getEnabledLdapConfigs() : [];

		const providers: { id: string; name: string; type: 'local' | 'ldap' | 'oidc'; initiateUrl?: string }[] = [];

		// Local auth is available unless DISABLE_LOCAL_LOGIN is set
		if (process.env.DISABLE_LOCAL_LOGIN !== 'true') {
			providers.push({ id: 'local', name: 'Local', type: 'local' });
		}

		// Add enabled LDAP providers (enterprise only)
		for (const config of ldapConfigs) {
			providers.push({
				id: `ldap:${config.id}`,
				name: config.name,
				type: 'ldap'
			});
		}

		// Add enabled OIDC providers (free for all)
		for (const config of oidcConfigs) {
			providers.push({
				id: `oidc:${config.id}`,
				name: config.name,
				type: 'oidc',
				initiateUrl: `/api/auth/oidc/${config.id}/initiate`
			});
		}

		// Whether the login page should go straight to the provider (OIDC_AUTOLOGIN).
		// The error and ?local=1 escape hatches are the page's to apply - it is the
		// only side that knows how the last attempt went.
		const autoLoginUrl = autoLoginTarget({
			enabled: process.env.OIDC_AUTOLOGIN === 'true',
			oidcInitiateUrls: providers
				.filter((p) => p.type === 'oidc')
				.map((p) => p.initiateUrl)
				.filter((u): u is string => !!u)
		});

		// Advertised only when the administrator allows it AND the deployment can
		// actually run a ceremony, so the login page never shows a dead button.
		const passkeys = passkeysOffered({
			enabled: passkeysEnabled,
			originUsable: isWebAuthnConfigured()
		});

		return json({
			providers,
			defaultProvider: settings.defaultProvider || 'local',
			passkeys,
			...(autoLoginUrl ? { autoLoginUrl } : {})
		});
	} catch (error) {
		console.error('Failed to get auth providers:', error);
		const fallbackProviders = process.env.DISABLE_LOCAL_LOGIN === 'true'
			? []
			: [{ id: 'local', name: 'Local', type: 'local' }];
		// Nothing is known about the setting here, so do not advertise passkeys: a
		// password form that works beats a button that may not.
		return json({ providers: fallbackProviders, passkeys: false });
	}
};
