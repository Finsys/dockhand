import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSecretProviders, createSecretProvider } from '$lib/server/db';
import { hasProvider } from '$lib/server/secretproviders';
import { authorize } from '$lib/server/authorize';
import { auditSecretProvider } from '$lib/server/audit';

/**
 * @openapi
 * summary: List configured secret providers (summaries never include the decrypted config)
 * resp-200: array<{id:integer!, name:string!, type:string!}>
 * resp-403: Permission denied (needs secrets:view)
 * resp-500: Failed to fetch secret providers
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('secrets', 'view'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		// Summaries never include the decrypted config.
		const providers = await getSecretProviders();
		return json(providers);
	} catch (error) {
		console.error('Error fetching secret providers:', error);
		return json({ error: 'Failed to fetch secret providers' }, { status: 500 });
	}
};

/**
 * @openapi
 * summary: Create a secret provider (Vault, Infisical, Doppler, 1Password Connect)
 * body: {name:string!, type:string!, config:object!}
 * resp-201: {id:integer!, name:string!, type:string!}
 * resp-400: Name and type are required, unknown provider type, config missing, or a provider with this name already exists
 * resp-403: Permission denied (needs secrets:create)
 * resp-500: Failed to create secret provider
 */
export const POST: RequestHandler = async (event) => {
	const { request, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('secrets', 'create'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const data = await request.json();
		const name = typeof data.name === 'string' ? data.name.trim() : '';
		const type = typeof data.type === 'string' ? data.type.trim() : '';
		const config = data.config;

		if (!name || !type) {
			return json({ error: 'Name and type are required' }, { status: 400 });
		}
		if (!hasProvider(type)) {
			return json({ error: `Unknown secret provider type: ${type}` }, { status: 400 });
		}
		if (!config || typeof config !== 'object' || Array.isArray(config)) {
			return json({ error: 'Config is required' }, { status: 400 });
		}

		const existing = await getSecretProviders();
		if (existing.some((p) => p.name.trim() === name)) {
			return json({ error: 'A secret provider with this name already exists' }, { status: 400 });
		}

		const provider = await createSecretProvider({ type, name, config });
		await auditSecretProvider(event, 'create', provider.id, provider.name, { type });
		// Never return the decrypted config.
		return json(provider, { status: 201 });
	} catch (error: any) {
		console.error('Error creating secret provider:', error);
		return json({ error: 'Failed to create secret provider' }, { status: 500 });
	}
};
