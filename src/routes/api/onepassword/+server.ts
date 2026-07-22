import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getOpServiceAccounts, createOpServiceAccount } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { auditOpServiceAccount } from '$lib/server/audit';

export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('secrets', 'view'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const accounts = await getOpServiceAccounts();
		return json(accounts.map((a) => ({ ...a, hasToken: true })));
	} catch (error) {
		console.error('Error fetching 1Password service accounts:', error);
		return json({ error: 'Failed to fetch service accounts' }, { status: 500 });
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
		const token = typeof data.token === 'string' ? data.token.trim() : '';

		if (!name || !token) {
			return json({ error: 'Name and token are required' }, { status: 400 });
		}

		const account = await createOpServiceAccount({ name, token });
		await auditOpServiceAccount(event, 'create', account.id, account.name);
		return json({ ...account, hasToken: true }, { status: 201 });
	} catch (error: any) {
		console.error('Error creating 1Password service account:', error);
		if (error.message?.includes('UNIQUE') || error.message?.includes('unique')) {
			return json({ error: 'A service account with this name already exists' }, { status: 400 });
		}
		return json({ error: 'Failed to create service account' }, { status: 500 });
	}
};
