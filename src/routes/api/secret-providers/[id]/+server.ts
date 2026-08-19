import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getSecretProviders,
	getSecretProviderById,
	updateSecretProvider,
	deleteSecretProvider
} from '$lib/server/db';
import { hasProvider } from '$lib/server/secretproviders';
import { redactProviderConfig } from '$lib/server/secretproviders/shared';
import { authorize } from '$lib/server/authorize';
import { auditSecretProvider } from '$lib/server/audit';

/**
 * @openapi
 * summary: Get one secret provider with its non-secret config coordinates (the token is redacted out)
 * path: id:integer The secret provider id
 * resp-200: {id:integer!, name:string!, type:string!, config:object!}
 * resp-400: Invalid secret provider ID
 * resp-403: Permission denied (needs secrets:view)
 * resp-404: Secret provider not found
 */
export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('secrets', 'view'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const id = Number.parseInt(params.id);
	if (Number.isNaN(id)) {
		return json({ error: 'Invalid secret provider ID' }, { status: 400 });
	}

	// Load the full (decrypted) row so the edit form can pre-fill the NON-secret
	// coordinates (host, projectId, mount, ...). redactProviderConfig strips the
	// token before it leaves the server, so the secret never reaches the client.
	const full = await getSecretProviderById(id);
	if (!full) {
		return json({ error: 'Secret provider not found' }, { status: 404 });
	}
	const { config, ...summary } = full;
	return json({ ...summary, config: redactProviderConfig(config) });
};

/**
 * @openapi
 * summary: Update a secret provider (name, type, and/or rotate its config); omitted fields are left unchanged
 * path: id:integer The secret provider id
 * body: {name:string, type:string, config:object}
 * resp-200: {id:integer!, name:string!, type:string!}
 * resp-400: Invalid ID, empty name, unknown type, config not an object, or the name already exists
 * resp-403: Permission denied (needs secrets:edit)
 * resp-404: Secret provider not found
 * resp-500: Failed to update secret provider
 */
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

		if (name !== undefined && name !== existing.name) {
			const all = await getSecretProviders();
			if (all.some((p) => p.id !== id && p.name.trim() === name)) {
				return json({ error: 'A secret provider with this name already exists' }, { status: 400 });
			}
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
		return json({ error: 'Failed to update secret provider' }, { status: 500 });
	}
};

/**
 * @openapi
 * summary: Delete a secret provider
 * path: id:integer The secret provider id
 * resp-200: {success:boolean!}
 * resp-400: Invalid secret provider ID
 * resp-403: Permission denied (needs secrets:delete)
 * resp-404: Secret provider not found
 * resp-500: Failed to delete secret provider
 */
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
