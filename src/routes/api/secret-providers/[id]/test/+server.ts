import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSecretProviderById } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { testProviderConnection } from '$lib/server/secretproviders';

/** Test a stored provider using its persisted (decrypted) config. */
export const POST: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('secrets', 'view'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const id = Number.parseInt(params.id);
	if (Number.isNaN(id)) {
		return json({ error: 'Invalid secret provider ID' }, { status: 400 });
	}

	const provider = await getSecretProviderById(id);
	if (!provider) {
		return json({ error: 'Secret provider not found' }, { status: 404 });
	}

	const result = await testProviderConnection(provider.type, provider.config);
	if (!result.ok) {
		return json({ ok: false, error: result.error }, { status: 200 });
	}
	return json({ ok: true });
};
