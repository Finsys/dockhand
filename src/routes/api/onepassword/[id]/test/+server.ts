import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getOpServiceAccountById } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { testConnection } from '$lib/server/onepassword';

export const POST: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('secrets', 'view'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const id = Number.parseInt(params.id);
	if (Number.isNaN(id)) {
		return json({ error: 'Invalid service account ID' }, { status: 400 });
	}

	const account = await getOpServiceAccountById(id);
	if (!account) {
		return json({ error: 'Service account not found' }, { status: 404 });
	}

	const result = await testConnection(account.token);
	if (!result.ok) {
		return json({ ok: false, error: result.error }, { status: 200 });
	}
	return json({ ok: true });
};
