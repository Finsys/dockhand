import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { testConnection } from '$lib/server/onepassword';

/** Test a token before it's persisted to the database. */
export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('secrets', 'create'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	let token = '';
	try {
		const data = await request.json();
		token = typeof data.token === 'string' ? data.token : '';
	} catch {
		return json({ error: 'Invalid request body' }, { status: 400 });
	}

	if (!token.trim()) {
		return json({ ok: false, error: 'Token is required' }, { status: 200 });
	}

	const result = await testConnection(token);
	return json(result);
};
