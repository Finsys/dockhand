import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRegistry, updateRegistry, deleteRegistry, setDefaultRegistry } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { auditRegistry } from '$lib/server/audit';
import { computeAuditDiff } from '$lib/utils/diff';

export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('registries', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid registry ID' }, { status: 400 });
		}

		const registry = await getRegistry(id);
		if (!registry) {
			return json({ error: 'Registry not found' }, { status: 404 });
		}

		// Don't expose password
		const { password, ...safeRegistry } = registry;
		return json({ ...safeRegistry, hasCredentials: !!password });
	} catch (error) {
		console.error('Error fetching registry:', error);
		return json({ error: 'Failed to fetch registry' }, { status: 500 });
	}
};

export const PUT: RequestHandler = async (event) => {
	const { params, request, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('registries', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid registry ID' }, { status: 400 });
		}

		// Get old values before update for diff
		const oldRegistry = await getRegistry(id);
		if (!oldRegistry) {
			return json({ error: 'Registry not found' }, { status: 404 });
		}

		const data = await request.json();
		const registry = await updateRegistry(id, {
			name: data.name,
			url: data.url,
			username: data.username,
			password: data.password,
			isDefault: data.isDefault
		});

		if (!registry) {
			return json({ error: 'Registry not found' }, { status: 404 });
		}

		// If this registry should be default, set it
		if (data.isDefault) {
			await setDefaultRegistry(id);
		}

		// Compute diff for audit
		const diff = computeAuditDiff(oldRegistry, registry);

		// Audit log
		await auditRegistry(event, 'update', registry.id, registry.name, diff);

		// Don't expose password
		const { password, ...safeRegistry } = registry;
		return json({ ...safeRegistry, hasCredentials: !!password });
	} catch (error: any) {
		console.error('Error updating registry:', error);
		if (error.message?.includes('UNIQUE constraint failed')) {
			return json({ error: 'A registry with this name already exists' }, { status: 400 });
		}
		return json({ error: 'Failed to update registry' }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async (event) => {
	const { params, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('registries', 'delete')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid registry ID' }, { status: 400 });
		}

		// Get registry name before deletion for audit log
		const registry = await getRegistry(id);
		if (!registry) {
			return json({ error: 'Registry not found' }, { status: 404 });
		}

		const deleted = await deleteRegistry(id);
		if (!deleted) {
			return json({ error: 'Registry cannot be deleted' }, { status: 400 });
		}

		// Audit log
		await auditRegistry(event, 'delete', id, registry.name);

		return json({ success: true });
	} catch (error) {
		console.error('Error deleting registry:', error);
		return json({ error: 'Failed to delete registry' }, { status: 500 });
	}
};
