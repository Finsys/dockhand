import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSecretProviders, createSecretProvider } from '$lib/server/db';
import { hasProvider } from '$lib/server/secretproviders';
import { authorize } from '$lib/server/authorize';
import { auditSecretProvider } from '$lib/server/audit';

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

		const provider = await createSecretProvider({ type, name, config });
		await auditSecretProvider(event, 'create', provider.id, provider.name, { type });
		// Never return the decrypted config.
		return json(provider, { status: 201 });
	} catch (error: any) {
		console.error('Error creating secret provider:', error);
		if (error.message?.includes('UNIQUE') || error.message?.includes('unique')) {
			return json({ error: 'A secret provider with this name already exists' }, { status: 400 });
		}
		return json({ error: 'Failed to create secret provider' }, { status: 500 });
	}
};
