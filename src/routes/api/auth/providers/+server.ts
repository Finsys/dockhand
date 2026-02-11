import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { isAuthEnabled, getEnabledLdapConfigs, getEnabledOidcConfigs } from '$lib/server/auth';
import { getAuthSettings } from '$lib/server/db';
import { isEnterprise } from '$lib/server/license';

// GET /api/auth/providers - Get available authentication providers
export const GET: RequestHandler = async () => {
	if (!(await isAuthEnabled())) {
		return json({ providers: [] });
	}

	try {
		// Fetch all provider configs in parallel
		const [settings, enterpriseEnabled, oidcConfigs] = await Promise.all([
			getAuthSettings(),
			isEnterprise(),
			getEnabledOidcConfigs()
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

		return json({
			providers,
			defaultProvider: settings.defaultProvider || 'local'
		});
	} catch (error) {
		console.error('Failed to get auth providers:', error);
		const fallbackProviders = process.env.DISABLE_LOCAL_LOGIN === 'true'
			? []
			: [{ id: 'local', name: 'Local', type: 'local' }];
		return json({ providers: fallbackProviders });
	}
};
