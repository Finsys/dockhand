import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getOpServiceAccounts,
	updateOpServiceAccount,
	deleteOpServiceAccount
} from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { auditOpServiceAccount } from '$lib/server/audit';

async function findAccount(id: number) {
	const all = await getOpServiceAccounts();
	return all.find((a) => a.id === id);
}

export const PUT: RequestHandler = async (event) => {
	const { params, request, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('secrets', 'edit'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = Number.parseInt(params.id);
		if (Number.isNaN(id)) {
			return json({ error: 'Invalid service account ID' }, { status: 400 });
		}

		const existing = await findAccount(id);
		if (!existing) {
			return json({ error: 'Service account not found' }, { status: 404 });
		}

		const data = await request.json();
		const name = typeof data.name === 'string' ? data.name.trim() : undefined;
		const token = typeof data.token === 'string' ? data.token.trim() : undefined;

		if (name !== undefined && !name) {
			return json({ error: 'Name cannot be empty' }, { status: 400 });
		}

		const updated = await updateOpServiceAccount(id, { name, token });
		if (!updated) {
			return json({ error: 'Service account not found' }, { status: 404 });
		}

		const details: Record<string, any> = {};
		if (name && name !== existing.name) details.name = { from: existing.name, to: name };
		if (token) details.tokenRotated = true;

		await auditOpServiceAccount(event, 'update', id, updated.name, details);
		return json({ ...updated, hasToken: true });
	} catch (error: any) {
		console.error('Error updating 1Password service account:', error);
		if (error.message?.includes('UNIQUE') || error.message?.includes('unique')) {
			return json({ error: 'A service account with this name already exists' }, { status: 400 });
		}
		return json({ error: 'Failed to update service account' }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async (event) => {
	const { params, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('secrets', 'delete'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = Number.parseInt(params.id);
		if (Number.isNaN(id)) {
			return json({ error: 'Invalid service account ID' }, { status: 400 });
		}

		const deleted = await deleteOpServiceAccount(id);
		if (!deleted) {
			return json({ error: 'Service account not found' }, { status: 404 });
		}

		await auditOpServiceAccount(event, 'delete', id, deleted.name);
		return json({ success: true });
	} catch (error) {
		console.error('Error deleting 1Password service account:', error);
		return json({ error: 'Failed to delete service account' }, { status: 500 });
	}
};
