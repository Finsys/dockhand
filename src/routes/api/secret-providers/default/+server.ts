import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSetting, setSetting, deleteSetting, getSecretProviders } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import {
	DEFAULT_SECRET_PROVIDER_SETTING,
	parseDefaultProviderId,
	resolveDefaultProviderId
} from '$lib/utils/default-secret-provider';

/**
 * @openapi
 * summary: Get the global default secret provider preselected for new stacks
 * description: Returns null when no default is set, or when the stored provider no longer exists.
 * resp-200: {providerId:integer}
 * resp-403: Permission denied (needs secrets:view)
 * resp-500: Failed to read the default secret provider
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('secrets', 'view'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const [raw, providers] = await Promise.all([
			getSetting(DEFAULT_SECRET_PROVIDER_SETTING),
			getSecretProviders()
		]);
		return json({ providerId: resolveDefaultProviderId(raw, providers) });
	} catch (error) {
		console.error('Error reading default secret provider:', error);
		return json({ error: 'Failed to read the default secret provider' }, { status: 500 });
	}
};

/**
 * @openapi
 * summary: Set or clear the global default secret provider
 * description: Pass a provider id to make it the default, or null to clear it.
 * body: {providerId:integer}
 * resp-200: {providerId:integer}
 * resp-400: Invalid provider id, or the provider does not exist
 * resp-403: Permission denied (needs secrets:edit)
 * resp-500: Failed to save the default secret provider
 */
export const PUT: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('secrets', 'edit'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const body = await request.json();

		if (body?.providerId === null || body?.providerId === undefined) {
			await deleteSetting(DEFAULT_SECRET_PROVIDER_SETTING);
			return json({ providerId: null });
		}

		const providerId = parseDefaultProviderId(body.providerId);
		if (providerId === null) {
			return json({ error: 'Invalid provider id' }, { status: 400 });
		}

		const providers = await getSecretProviders();
		if (!providers.some((p) => p.id === providerId)) {
			return json({ error: 'Secret provider not found' }, { status: 400 });
		}

		await setSetting(DEFAULT_SECRET_PROVIDER_SETTING, providerId);
		return json({ providerId });
	} catch (error) {
		console.error('Error saving default secret provider:', error);
		return json({ error: 'Failed to save the default secret provider' }, { status: 500 });
	}
};
