import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getSecretProviders,
	getSecretProviderById,
	updateSecretProvider,
	deleteSecretProvider
} from '$lib/server/db';
import { hasProvider } from '$lib/server/secretproviders';
import { authorize } from '$lib/server/authorize';
import { auditSecretProvider } from '$lib/server/audit';

export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('secrets', 'view'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const id = Number.parseInt(params.id);
	if (Number.isNaN(id)) {
		return json({ error: 'Invalid secret provider ID' }, { status: 400 });
	}

	const providers = await getSecretProviders();
	const provider = providers.find((p) => p.id === id);
	if (!provider) {
		return json({ error: 'Secret provider not found' }, { status: 404 });
	}
	// Summary only, never the decrypted config.
	return json(provider);
};

export const PUT: RequestHandler = async (event) => {
	const { params, request, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('secrets', 'edit'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = Number.parseInt(params.id);
		if (Number.isNaN(id)) {
			return json({ error: 'Invalid secret provider ID' }, { status: 400 });
		}

		const existing = await getSecretProviderById(id);
		if (!existing) {
			return json({ error: 'Secret provider not found' }, { status: 404 });
		}

		const data = await request.json();
		const name = typeof data.name === 'string' ? data.name.trim() : undefined;
		const type = typeof data.type === 'string' ? data.type.trim() : undefined;
		const config = 'config' in data ? data.config : undefined;

		if (name !== undefined && !name) {
			return json({ error: 'Name cannot be empty' }, { status: 400 });
		}
		if (type !== undefined && !hasProvider(type)) {
			return json({ error: `Unknown secret provider type: ${type}` }, { status: 400 });
		}
		if (config !== undefined && (typeof config !== 'object' || config === null || Array.isArray(config))) {
			return json({ error: 'Config must be an object' }, { status: 400 });
		}

		const updated = await updateSecretProvider(id, { name, type, config });
		if (!updated) {
			return json({ error: 'Secret provider not found' }, { status: 404 });
		}

		const details: Record<string, any> = {};
		if (name && name !== existing.name) details.name = { from: existing.name, to: name };
		if (type && type !== existing.type) details.type = { from: existing.type, to: type };
		if (config !== undefined) details.configRotated = true;

		await auditSecretProvider(event, 'update', id, updated.name, details);
		// Never return the decrypted config.
		return json(updated);
	} catch (error: any) {
		console.error('Error updating secret provider:', error);
		if (error.message?.includes('UNIQUE') || error.message?.includes('unique')) {
			return json({ error: 'A secret provider with this name already exists' }, { status: 400 });
		}
		return json({ error: 'Failed to update secret provider' }, { status: 500 });
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
			return json({ error: 'Invalid secret provider ID' }, { status: 400 });
		}

		const deleted = await deleteSecretProvider(id);
		if (!deleted) {
			return json({ error: 'Secret provider not found' }, { status: 404 });
		}

		await auditSecretProvider(event, 'delete', id, deleted.name);
		return json({ success: true });
	} catch (error) {
		console.error('Error deleting secret provider:', error);
		return json({ error: 'Failed to delete secret provider' }, { status: 500 });
	}
};
