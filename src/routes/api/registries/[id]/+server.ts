import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRegistry, updateRegistry, deleteRegistry, setDefaultRegistry } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { auditRegistry } from '$lib/server/audit';
import { computeAuditDiff } from '$lib/utils/diff';
import { parseRegistryUrl, DOCKER_HUB_HOSTS } from '$lib/server/docker';

/**
 * @openapi
 * summary: Get a single registry by ID with the password stripped (only a hasCredentials flag)
 * path: id:integer! Registry ID (from GET /api/registries)
 * resp-200: {id:integer!, name:string!, url:string!, isDefault:boolean, hasCredentials:boolean!}
 * resp-400: The id path segment is not a valid integer
 * resp-403: Caller lacks the registries:view permission
 * resp-404: No registry exists with that ID
 * resp-500: Failed to read the registry
 */
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

/**
 * @openapi
 * summary: Update a registry (optionally set as default); credentials are trimmed and the response strips the password
 * path: id:integer! Registry ID (from GET /api/registries)
 * body: {name:string, url:string, username:string, password:string, isDefault:boolean}
 * body-example: {"name":"GHCR","url":"https://ghcr.io","username":"deploy","password":"***","isDefault":true}
 * resp-200: {id:integer!, name:string!, url:string!, isDefault:boolean, hasCredentials:boolean!}
 * resp-400: Invalid id, or a duplicate registry name
 * resp-403: Caller lacks the registries:edit permission
 * resp-404: No registry exists with that ID
 * resp-500: The update failed
 */
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
		// Trim username/password to prevent stray whitespace from copy-paste corrupting
		// the X-Registry-Auth / Authorization headers (#1105).
		const trimmedUsername = typeof data.username === 'string' ? data.username.trim() : data.username;
		const trimmedPassword = typeof data.password === 'string' ? data.password.trim() : data.password;

		// Diagnostic logging (#1105) — never logs the plaintext credential
		const userLen = typeof trimmedUsername === 'string' ? trimmedUsername.length : 0;
		const pwLen = typeof trimmedPassword === 'string' ? trimmedPassword.length : 0;
		const { host: normalizedHost } = parseRegistryUrl(data.url);
		const hubTag = DOCKER_HUB_HOSTS.has(normalizedHost) ? ' (docker-hub)' : '';
		console.log(`[Registry] update id=${id}: url=${data.url} normalized=${normalizedHost}${hubTag} user(len=${userLen}) pw(len=${pwLen})`);
		const registry = await updateRegistry(id, {
			name: data.name,
			url: data.url,
			username: trimmedUsername,
			password: trimmedPassword,
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

/**
 * @openapi
 * summary: Delete a registry by ID
 * path: id:integer! Registry ID (from GET /api/registries)
 * resp-200: {success:boolean!}
 * resp-200-example: {"success":true}
 * resp-400: Invalid id, or the registry cannot be deleted
 * resp-403: Caller lacks the registries:delete permission
 * resp-404: No registry exists with that ID
 * resp-500: The deletion failed
 */
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
